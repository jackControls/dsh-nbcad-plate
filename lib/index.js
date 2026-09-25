/**
 * dsh-nbcad-plate: DeepSeek Harness plugin that turns 2D plate prints into
 * noBS CAD scripts and STEP files.
 *
 * It registers one skill, `nbcad-plate` (the standard workflow for flat plate
 * parts, simple or dense), and four model-facing tools that drive a headless
 * noBS CAD engine: `nbcad_run_script` runs a version 1 `.nbcad.jsonc` script
 * and exports STEP, `nbcad_inspect_step` re-imports a STEP file and lists its
 * bounding box and holes, `nbcad_overlay_print` draws a model's holes on the print
 * for a visual check. Everything the model builds goes through the
 * ordinary script interpreter, never through a second modelling path.
 *
 * @module dsh-nbcad-plate
 */

import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants as fsConstants, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'nbcad-plate'
export const inject = ['tools', 'skills']

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const pythonDir = join(packageRoot, 'python')
const skillDir = join(packageRoot, 'skill')

export const Config = z.object({
  /** Absolute path of the headless noBS CAD MCP executable (nbcad-mcp). Falls back to $NBCAD_MCP. */
  server: z.string().default(''),
  /** Absolute path of the print-probe binary (native/print-probe, `cargo build --release`). Falls back to $NBCAD_PRINT_PROBE, then the package's own build. */
  probe: z.string().default(''),
  /** Python 3 interpreter used for the helper scripts. */
  python: z.string().default('python3'),
  /** Per-call timeout for an engine run. */
  timeoutMs: z.number().default(10 * 60 * 1000),
})

function resolveServer(config) {
  const server = config.server || process.env.NBCAD_MCP || ''
  if (!server) throw new Error('dsh-nbcad-plate: set config.server or NBCAD_MCP to the nbcad-mcp executable')
  return server
}

function resolvePath(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

/** Run one helper script and parse its single-line JSON result. */
function runHelper(config, script, args, signal) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(config.python, [join(pythonDir, script), '--json', ...args], {
      env: { ...process.env, NBCAD_MCP: resolveServer(config) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), config.timeoutMs)
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const line = stdout.trim().split('\n').filter(Boolean).pop() ?? ''
      try {
        const value = JSON.parse(line)
        if (stderr.trim() && !value.ok) value.stderr = stderr.trim().slice(-2000)
        resolveResult(value)
      } catch {
        reject(new Error(`helper ${script} exited with ${code} and no JSON result: ${stderr.slice(-2000) || stdout.slice(-2000)}`))
      }
    })
  })
}

function resolveProbe(config) {
  return config.probe || process.env.NBCAD_PRINT_PROBE || join(packageRoot, 'native', 'print-probe', 'target', 'release', 'print-probe')
}

/** Run the print-probe binary and parse its single-line JSON result. */
function runProbe(config, args, signal) {
  return new Promise((resolveResult, reject) => {
    const bin = resolveProbe(config)
    const child = spawn(bin, args, { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), config.timeoutMs)
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); resolveResult({ ok: false, error: `print-probe not runnable at ${bin}: ${error.message}. Build it with: cargo build --release --manifest-path native/print-probe/Cargo.toml` }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const line = stdout.trim().split('\n').filter(Boolean).pop() ?? ''
      try {
        resolveResult(JSON.parse(line))
      } catch {
        resolveResult({ ok: false, error: `print-probe exited with ${code}: ${stderr.trim().slice(-2000) || stdout.slice(-2000)}` })
      }
    })
  })
}

/** Inspect a STEP once and cache its hole list as <step>.holes.json for the probe. */
async function holesJsonFor(config, stepPath) {
  const jsonPath = stepPath + '.holes.json'
  try {
    const { statSync } = await import('node:fs')
    if (statSync(jsonPath).mtimeMs >= statSync(stepPath).mtimeMs) return jsonPath
  } catch {}
  const value = await runHelper(config, 'inspect_step.py', [stepPath])
  if (!value.ok) throw new Error(`inspect failed: ${value.error}`)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(jsonPath, JSON.stringify(value))
  return jsonPath
}


// ----------------------------------------------------------------------------- web panel service
//
// The browser half (lib/client.js) adds a "2D → 3D" panel to the dsh Web UI. It talks to
// this host half over same-origin HTTP routes registered on dsh's own web server, which
// exist only in a Web composition; headless profiles skip them.

const ROUTE_PREFIX = '/dsh-nbcad/api'
/** noBS CAD desktop heartbeats older than this are stale (mcp-server/src/session.rs HEARTBEAT_STALE_MS). */
const HEARTBEAT_STALE_MS = 30_000
const PRINT_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg'])
const DOWNLOAD_EXTENSIONS = new Set(['.step', '.stp', '.md', '.jsonc', '.png', '.pdf'])
const MAX_PRINT_BYTES = 64 * 1024 * 1024

/** Where the noBS CAD desktop publishes live sessions (docs/mcp-harness.md). */
function sessionRegistryDir() {
  return process.env.NBCAD_SESSION_DIR || join(tmpdir(), 'nbcad-sessions')
}

/** Find an executable: an absolute or relative path as is, a bare name on PATH. */
function findExecutable(name) {
  if (!name) return null
  const candidates = name.includes('/') ? [resolve(name)] : (process.env.PATH || '').split(':').filter(Boolean).map((dir) => join(dir, name))
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK)
      if (statSync(candidate).isFile()) return candidate
    } catch {}
  }
  return null
}

/**
 * Is a noBS CAD desktop running? Every open desktop document writes
 * <registry>/<uuid>/heartbeat.json with `updated_ms`; a heartbeat within 30 s means the
 * publisher is alive. Reading a handful of small files is cheap enough to poll every
 * couple of seconds, which is what the panel does.
 */
function desktopStatus() {
  const registry = sessionRegistryDir()
  const sessions = []
  let scanned = 0
  const now = Date.now()
  try {
    for (const entry of readdirSync(registry)) {
      const file = join(registry, entry, 'heartbeat.json')
      let stat
      try { stat = statSync(file) } catch { continue }
      scanned += 1
      if (now - stat.mtimeMs > 10 * 60_000) continue // an old file cannot be a fresh heartbeat
      try {
        const beat = JSON.parse(readFileSync(file, 'utf8'))
        const updated = Number(beat.updated_ms) || Math.round(stat.mtimeMs)
        const ageMs = Math.max(0, now - updated)
        if (ageMs <= HEARTBEAT_STALE_MS) {
          sessions.push({ sessionId: entry, ageMs, documentId: beat.document_id ?? beat.project_session_id ?? null, windowId: beat.window_id ?? null, generation: beat.generation ?? null, interfaceVersion: beat.interface_version ?? null })
        }
      } catch {}
    }
  } catch {
    return { running: false, registry, registryPresent: false, sessions: [], scanned: 0, staleMs: HEARTBEAT_STALE_MS }
  }
  sessions.sort((a, b) => a.ageMs - b.ageMs)
  return { running: sessions.length > 0, registry, registryPresent: true, sessions, scanned, staleMs: HEARTBEAT_STALE_MS }
}

let environmentCache = { at: 0, value: null }
/** Slow checks (spawning python and pdftoppm) are refreshed at most once a minute. */
function environmentStatus(config) {
  if (Date.now() - environmentCache.at < 60_000 && environmentCache.value) return environmentCache.value
  const python = findExecutable(config.python || 'python3')
  let pythonVersion = null
  if (python) {
    const run = spawnSync(python, ['--version'], { encoding: 'utf8', timeout: 5000 })
    pythonVersion = (run.stdout || run.stderr || '').trim() || null
  }
  const value = { python: { path: python, version: pythonVersion }, pdftoppm: { path: findExecutable('pdftoppm') } }
  environmentCache = { at: Date.now(), value }
  return value
}

let statusCache = { at: 0, value: null }
function statusReport(config) {
  if (Date.now() - statusCache.at < 1000 && statusCache.value) return statusCache.value
  const serverName = config.server || process.env.NBCAD_MCP || 'nbcad-mcp'
  const engine = findExecutable(serverName)
  const probe = findExecutable(resolveProbe(config))
  const value = {
    ok: true,
    checkedAt: Date.now(),
    engine: { configured: serverName, path: engine, ready: engine !== null },
    probe: { path: probe, ready: probe !== null },
    desktop: desktopStatus(),
    environment: environmentStatus(config),
  }
  statusCache = { at: Date.now(), value }
  return value
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
  res.end(body)
}

function readBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error(`body larger than ${limit} bytes`)); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** A workspace directory the browser named: must exist and be a directory. */
function workspaceDir(value) {
  if (!value || !isAbsolute(value)) throw new Error('dir must be an absolute workspace path')
  const dir = resolve(value)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`not a directory: ${dir}`)
  return dir
}

function insideDir(dir, file) {
  const target = resolve(file)
  return target === dir || target.startsWith(dir + '/')
}

function safeName(name) {
  const base = basename(String(name || '')).replace(/[^A-Za-z0-9._ -]+/g, '_').replace(/^\.+/, '')
  if (!base) throw new Error('empty file name')
  return base
}

/** Turn a raster print into a PDF so the probe and pdftoppm crops work on it. */
function rasterToPdf(imagePath) {
  const pdfPath = imagePath.replace(/\.[^.]+$/, '') + '.pdf'
  const attempts = process.platform === 'darwin'
    ? [['sips', ['-s', 'format', 'pdf', imagePath, '--out', pdfPath]], ['img2pdf', [imagePath, '-o', pdfPath]], ['convert', [imagePath, pdfPath]]]
    : [['img2pdf', [imagePath, '-o', pdfPath]], ['convert', [imagePath, pdfPath]]]
  for (const [command, args] of attempts) {
    if (!findExecutable(command)) continue
    const run = spawnSync(command, args, { timeout: 60_000 })
    if (run.status === 0 && existsSync(pdfPath)) return { pdfPath, converter: command }
  }
  return { pdfPath: null, converter: null }
}

function listOutputs(dir) {
  const files = []
  for (const sub of ['out', '.']) {
    const folder = join(dir, sub)
    let names = []
    try { names = readdirSync(folder) } catch { continue }
    for (const name of names) {
      const ext = extname(name).toLowerCase()
      if (!['.step', '.stp', '.md', '.jsonc'].includes(ext)) continue
      const file = join(folder, name)
      try {
        const stat = statSync(file)
        if (stat.isFile()) files.push({ name, path: file, relative: sub === '.' ? name : `${sub}/${name}`, size: stat.size, modifiedAt: Math.round(stat.mtimeMs), kind: ext === '.step' || ext === '.stp' ? 'step' : ext === '.md' ? 'report' : 'script' })
      } catch {}
    }
  }
  files.sort((a, b) => b.modifiedAt - a.modifiedAt)
  return files
}

function registerWebRoutes(ctx, config) {
  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const route = url.pathname.slice(ROUTE_PREFIX.length)
    try {
      if (route === '/status' && req.method === 'GET') return sendJson(res, 200, statusReport(config))
      if (route === '/print' && req.method === 'POST') {
        const dir = workspaceDir(url.searchParams.get('dir'))
        const name = safeName(url.searchParams.get('name'))
        const ext = extname(name).toLowerCase()
        if (!PRINT_EXTENSIONS.has(ext)) throw new Error('the print must be a .pdf, .png or .jpg file')
        const body = await readBody(req, MAX_PRINT_BYTES)
        if (body.length === 0) throw new Error('empty file')
        const prints = join(dir, 'prints')
        mkdirSync(prints, { recursive: true })
        const file = join(prints, name)
        writeFileSync(file, body)
        let pdf = { pdfPath: ext === '.pdf' ? file : null, converter: null }
        if (ext !== '.pdf') pdf = rasterToPdf(file)
        return sendJson(res, 200, { ok: true, path: file, pdfPath: pdf.pdfPath, converter: pdf.converter, bytes: body.length })
      }
      if (route === '/local-print' && req.method === 'POST') {
        // a print that already exists on this machine: copy it into the workspace
        const dir = workspaceDir(url.searchParams.get('dir'))
        const source = String(url.searchParams.get('path') || '')
        if (!isAbsolute(source) || !existsSync(source) || !statSync(source).isFile()) throw new Error('path must be an existing file on this machine')
        const name = safeName(basename(source))
        const ext = extname(name).toLowerCase()
        if (!PRINT_EXTENSIONS.has(ext)) throw new Error('the print must be a .pdf, .png or .jpg file')
        const prints = join(dir, 'prints')
        mkdirSync(prints, { recursive: true })
        const file = join(prints, name)
        if (resolve(source) !== file) writeFileSync(file, readFileSync(source))
        let pdf = { pdfPath: ext === '.pdf' ? file : null, converter: null }
        if (ext !== '.pdf') pdf = rasterToPdf(file)
        return sendJson(res, 200, { ok: true, path: file, pdfPath: pdf.pdfPath, converter: pdf.converter, bytes: statSync(file).size })
      }
      if (route === '/outputs' && req.method === 'GET') {
        const dir = workspaceDir(url.searchParams.get('dir'))
        return sendJson(res, 200, { ok: true, dir, files: listOutputs(dir) })
      }
      if (route === '/file' && req.method === 'GET') {
        const dir = workspaceDir(url.searchParams.get('dir'))
        const file = resolve(String(url.searchParams.get('path') || ''))
        if (!insideDir(dir, file) || !DOWNLOAD_EXTENSIONS.has(extname(file).toLowerCase()) || !existsSync(file)) throw new Error('file must be a STEP, report or script inside the workspace')
        const stat = statSync(file)
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': stat.size, 'content-disposition': `attachment; filename="${basename(file).replace(/"/g, '')}"`, 'cache-control': 'no-store' })
        createReadStream(file).pipe(res)
        return
      }
      sendJson(res, 404, { ok: false, error: `unknown route ${route}` })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message || error) })
    }
  }
  // the web server matches a prefix route as `path === prefix || path.startsWith(prefix + '/')`
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handle }), 'nbcad-plate: web routes')
}

function skillContent() {
  const raw = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
  // Strip the frontmatter so the same file serves the filesystem provider and this runtime registration.
  const body = raw.startsWith('---') ? raw.slice(raw.indexOf('\n---', 3) + 4) : raw
  return body.replaceAll('{{SKILL_DIR}}', skillDir).trim()
}

function renderJson(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 1) }]
}

export function apply(ctx, config) {
  ctx.inject(['webServer'], (web) => registerWebRoutes(web, config))

  ctx.skills.register({
    name: 'nbcad-plate',
    description: 'Turn a 2D engineering print of a flat plate part (simple or dense: notches, slots, through/counterbored/blind/tapped/edge holes, bolt circles) into a noBS CAD script and a STEP file. Load before any CAD work on a plate print.',
    whenToUse: 'The task mentions a drawing, print, PDF or scan of a plate, bracket, side plate, base plate or similar flat part and asks for a 3D model, STEP, or noBS CAD script.',
    source: 'runtime',
    content: skillContent(),
    resourceBase: { kind: 'directory', path: skillDir },
  })

  ctx.tools.register(defineTool({
    name: 'nbcad_run_script',
    description: 'Run a version 1 noBS CAD .nbcad.jsonc script headlessly in a blank document and export the solid as STEP. Returns ok/steps_completed/checks_completed, a scene summary (bounding box, planar and cylindrical face counts), the vertical holes found (x, y from the lower-left corner of the bounding box, diameter, counterbore) and the export path, or the failing step and reason. Paths are absolute or relative to the workspace.',
    parameters: {
      script_path: { type: 'string', required: true, description: 'Path of the .nbcad.jsonc script to run' },
      step_path: { type: 'string', required: true, description: 'Path of the STEP file to write' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderJson(value),
    },
    timeoutMs: config.timeoutMs + 5000,
    async execute(args, exec) {
      return runHelper(config, 'run_script.py', [resolvePath(args.script_path), resolvePath(args.step_path)], exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'nbcad_inspect_step',
    description: 'Re-import a STEP file headlessly and report its bounding box, face counts and vertical holes (x, y from the lower-left corner of the bounding box, diameter, counterbore). Use it to verify an exported part against the feature table.',
    parameters: {
      step_path: { type: 'string', required: true, description: 'Path of the STEP file' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderJson(value),
    },
    timeoutMs: config.timeoutMs + 5000,
    async execute(args, exec) {
      return runHelper(config, 'inspect_step.py', [resolvePath(args.step_path)], exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'nbcad_overlay_print',
    description: 'Draw the holes of a STEP file (or of a JSON hole list written by nbcad_run_script) onto the plan view of the plate print and write a PNG to look at with read_image. The plate outline is located on the page from length_mm and width_mm and its four corners are refined, so a slightly rotated scan maps correctly; plate millimetres use the lower-left corner of the plan view as origin, y up. Without region the whole page is drawn at 150 dpi; with region "x0,y0,x1,y1" (mm) a high-resolution crop of that window is written (default 400 dpi), which is the form to check hole by hole. Red = hole at its diameter, blue = counterbore, green = the calibrated outline. Every red circle must sit on a drawn hole symbol and every drawn hole symbol must carry a red circle.',
    parameters: {
      pdf_path: { type: 'string', required: true, description: 'Path of the print (PDF)' },
      step_path: { type: 'string', required: true, description: 'Path of the STEP file to draw (or a .json hole list)' },
      out_png: { type: 'string', required: true, description: 'Path of the PNG to write' },
      length_mm: { type: 'number', required: true, description: 'Plate length along x (the longer plan-view edge)' },
      width_mm: { type: 'number', required: true, description: 'Plate width along y' },
      region: { type: 'string', description: 'Optional millimetre window "x0,y0,x1,y1" to crop at high resolution' },
      dpi: { type: 'integer', description: 'Render resolution of a region crop (default 400)' },
      page: { type: 'integer', description: 'PDF page (default 1)' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderJson(value),
    },
    timeoutMs: config.timeoutMs + 5000,
    async execute(args, exec) {
      const extra = []
      if (args.region) extra.push('--region', args.region)
      if (args.dpi) extra.push('--dpi', String(args.dpi))
      if (args.page) extra.push('--page', String(args.page))
      // Prefer the native probe's crop (same calibration as ring-score and symbols, sub-second); fall back to the Python renderer.
      const { existsSync } = await import('node:fs')
      if (existsSync(resolveProbe(config))) {
        const step = resolvePath(args.step_path)
        const holes = step.endsWith('.json') ? step : await holesJsonFor(config, step)
        const region = args.region || `-5,-5,${args.length_mm + 5},${args.width_mm + 5}`
        const dpi = args.dpi || (args.region ? 400 : 150)
        const result = await runProbe(config, ['crop', '--pdf', resolvePath(args.pdf_path), '--length', String(args.length_mm), '--width', String(args.width_mm), '--region', region, '--dpi', String(dpi), '--grid', '10', '--holes', holes, '--out', resolvePath(args.out_png)], exec.signal)
        if (result.ok) return result
      }
      return runHelper(config, 'overlay_print.py', [resolvePath(args.pdf_path), resolvePath(args.step_path), resolvePath(args.out_png), '--length', String(args.length_mm), '--width', String(args.width_mm), ...extra], exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'nbcad_print_probe',
    description: 'Fast pixel checks on the scanned print (a native binary, well under a second per call; renders are cached). action "calibrate": find the plate outline on the page and report its corners, scale and skew. action "crop": write a PNG of a millimetre window with green tick marks every grid_mm (long tick and faint line every 5 ticks) and, when step_path is given, the model holes in red / counterbores in blue; read positions straight off the ticks. action "ring-score": for every hole of the STEP (or JSON hole list) say what is drawn at that point or within search_mm of it: symbol (a circle with a light interior, with its centre and offset in mm, its drawn diameter and counterbore), dot (a solid dot), dashed (a partial ring such as a hidden-line circle), none; run it after every script run and look at each hole with offset_mm over 1 or drawn none. action "symbols": list the circles and dots found at ink crossings in a region and match them to the model holes: model_only = model holes with no drawn symbol, print_only = drawn symbols with no model hole. Text, arrowheads and concentric rings can still appear in print_only, so treat those entries as places to look at on a crop, never as positions to model from.',
    parameters: {
      action: { type: 'string', required: true, enum: ['calibrate', 'crop', 'ring-score', 'symbols'], description: 'Which check to run' },
      pdf_path: { type: 'string', required: true, description: 'Path of the print (PDF)' },
      length_mm: { type: 'number', required: true, description: 'Plate length along x (the longer plan-view edge)' },
      width_mm: { type: 'number', required: true, description: 'Plate width along y' },
      step_path: { type: 'string', description: 'STEP file (or a .json hole list written by nbcad_run_script); required for ring-score, optional for crop and symbols' },
      region: { type: 'string', description: 'Millimetre window "x0,y0,x1,y1", lower-left origin; required for crop, optional for symbols (default: the whole plate)' },
      out_png: { type: 'string', description: 'PNG to write (crop; optional for symbols, which then draws matched = green, model-only = red, print-only = magenta)' },
      dpi: { type: 'integer', description: 'Render resolution (crop default 400, ring-score 600, symbols 400)' },
      grid_mm: { type: 'number', description: 'crop: tick spacing in mm (default 10; 0 for none)' },
      search_mm: { type: 'number', description: 'ring-score: how far around each hole to look for a drawn symbol (default 2.5)' },
      page: { type: 'integer', description: 'PDF page (default 1)' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderJson(value),
    },
    timeoutMs: config.timeoutMs + 5000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const a = [args.action, '--pdf', resolvePath(args.pdf_path), '--length', String(args.length_mm), '--width', String(args.width_mm)]
      if (args.step_path) a.push('--holes', resolvePath(args.step_path).endsWith('.json') ? resolvePath(args.step_path) : await holesJsonFor(config, resolvePath(args.step_path)))
      if (args.region) a.push('--region', args.region)
      if (args.out_png) a.push('--out', resolvePath(args.out_png))
      if (args.dpi) a.push('--dpi', String(args.dpi))
      if (args.grid_mm !== undefined && args.action === 'crop') a.push('--grid', String(args.grid_mm))
      else if (args.action === 'crop') a.push('--grid', '10')
      if (args.search_mm) a.push('--search', String(args.search_mm))
      if (args.page) a.push('--page', String(args.page))
      if (args.action === 'ring-score' && !args.step_path) return { ok: false, error: 'ring-score needs step_path' }
      if (args.action === 'crop' && (!args.region || !args.out_png)) return { ok: false, error: 'crop needs region and out_png' }
      return runProbe(config, a, exec.signal)
    },
  }))
}
