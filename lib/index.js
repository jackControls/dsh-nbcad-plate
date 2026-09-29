/**
 * dsh-nobs-cad-step: DeepSeek Harness plugin that turns 2D plate prints into
 * noBS CAD scripts and STEP files.
 *
 * It registers one skill, `nobs-cad-step` (the standard workflow for flat plate
 * parts, simple or dense), and five model-facing tools that drive a headless
 * noBS CAD engine: `nbcad_run_script` runs a version 1 `.nbcad.jsonc` script
 * and exports STEP, `nbcad_inspect_step` re-imports a STEP file and lists its
 * bounding box and holes, `nbcad_overlay_print` draws a model's holes on the
 * print for a visual check, `nbcad_print_probe` is the native pixel toolkit.
 * Everything the model builds goes through the ordinary script interpreter,
 * never through a second modelling path.
 *
 * The plugin needs nothing besides Node, the noBS CAD engine and the
 * print-probe binary packed under bin/<platform>/ (it renders PDFs itself).
 *
 * @module dsh-nobs-cad-step
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { checkStep, inspectStep, runScript } from './cad.js'
import { PLATFORM, PROBE_NAME, discoverEngine, ensureExecutable, findExecutable, isFile, platformCandidates, resolvePath, sessionRegistryDir, verifyPackedProbe } from './host-utils.js'
import { PANEL_TOKEN_GLOBAL, ROUTE_PREFIX, createRouteHandler } from './routes.js'

export const name = 'nobs-cad-step'
export const inject = ['tools', 'skills']

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const skillDir = join(packageRoot, 'skill')
const binDir = join(packageRoot, 'bin')
const ENGINE_NAME = 'nbcad-mcp'

export const Config = z.object({
  /** The engine: the noBS CAD application executable (started with --headless) or the developer build nbcad-mcp; a bare name is looked up on PATH. Empty means auto-discovery: PATH, a running noBS CAD, the installed application. Falls back to $NBCAD_MCP. */
  server: z.string().default(''),
  /** Arguments for the engine; by default --headless for the application, none for nbcad-mcp. */
  serverArgs: z.array(z.string()).default([]),
  /** Path of a print-probe binary to use instead of the one packed for this platform. Falls back to $NBCAD_PRINT_PROBE. */
  probe: z.string().default(''),
  /** Per-call timeout for an engine run. */
  timeoutMs: z.number().default(10 * 60 * 1000),
})

let engineCache = { at: 0, value: null }
/** The engine and how it was found; discovery spawns a process or two, so it is cached briefly. */
function engineStatus(config) {
  if (Date.now() - engineCache.at < 10_000 && engineCache.value) return engineCache.value
  const engine = discoverEngine(config)
  const value = { ...engine, ready: engine.path !== null }
  engineCache = { at: Date.now(), value }
  return value
}

/** The engine as {path, args} for the session helpers. */
function resolveServer(config) {
  const engine = engineStatus(config)
  if (!engine.path) throw new Error(`dsh-nobs-cad-step: no noBS CAD engine found (looked for "${engine.configured}"): set config.server or NBCAD_MCP to the noBS CAD executable (or ${ENGINE_NAME}), put it on the PATH, or start noBS CAD once`)
  return { path: engine.path, args: engine.args }
}

/**
 * The print-probe binary: config.probe, then $NBCAD_PRINT_PROBE, then the copy packed for
 * this platform under bin/, then a local cargo build, then PATH.
 */
function probeStatus(config) {
  const candidates = [
    config.probe ? { path: resolvePath(config.probe), source: 'config' } : null,
    process.env.NBCAD_PRINT_PROBE ? { path: resolvePath(process.env.NBCAD_PRINT_PROBE), source: 'env' } : null,
    ...platformCandidates().map((platform) => ({ path: join(binDir, platform, PROBE_NAME), source: 'packaged', platform })),
    { path: join(packageRoot, 'native', 'print-probe', 'target', 'release', PROBE_NAME), source: 'built' },
  ].filter(Boolean)
  const rejected = []
  for (const candidate of candidates) {
    if (!isFile(candidate.path)) continue
    if (candidate.source === 'packaged') {
      // a packed binary must be the one bin/SHA256SUMS names; anything else is skipped and reported
      const verdict = packedProbeVerdict(candidate.platform, candidate.path)
      if (!verdict.ok) { rejected.push({ path: candidate.path, reason: verdict.reason }); continue }
      ensureExecutable(candidate.path)
      return { path: candidate.path, source: 'packaged', sha256: verdict.sha256, ready: true, platform: PLATFORM, rejected }
    }
    ensureExecutable(candidate.path)
    return { path: candidate.path, source: candidate.source, ready: true, platform: PLATFORM, rejected }
  }
  const onPath = findExecutable(PROBE_NAME)
  if (onPath) return { path: onPath, source: 'path', ready: true, platform: PLATFORM, rejected }
  return { path: null, source: null, ready: false, platform: PLATFORM, rejected, error: rejected[0]?.reason ?? null }
}

const probeVerdicts = new Map()
/** bin/SHA256SUMS check of one packed binary, cached by size and mtime (a hash of 5 MB per status call would add up). */
function packedProbeVerdict(platform, path) {
  const stat = statSync(path)
  const cached = probeVerdicts.get(path)
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.verdict
  const verdict = verifyPackedProbe(binDir, platform, PROBE_NAME)
  probeVerdicts.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, verdict })
  return verdict
}

/** Run the print-probe binary and parse its single-line JSON result. */
function runProbe(config, args, signal) {
  return new Promise((resolveResult) => {
    const probe = probeStatus(config)
    if (!probe.ready) return resolveResult({ ok: false, error: `no print-probe binary for ${PLATFORM}: set config.probe to a build for this machine (cargo build --release --manifest-path native/print-probe/Cargo.toml)` })
    const child = spawn(probe.path, args, { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), config.timeoutMs)
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); resolveResult({ ok: false, error: `print-probe not runnable at ${probe.path}: ${error.message}` }) })
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
    if (statSync(jsonPath).mtimeMs >= statSync(stepPath).mtimeMs) return jsonPath
  } catch {}
  const value = await inspectStep(resolveServer(config), stepPath)
  if (!value.ok) throw new Error(`inspect failed: ${value.error}`)
  writeFileSync(jsonPath, JSON.stringify(value))
  return jsonPath
}

/** A STEP path is inspected first; a .json hole list is passed through. */
async function holesArgument(config, stepPath) {
  const path = resolvePath(stepPath)
  return path.toLowerCase().endsWith('.json') ? path : holesJsonFor(config, path)
}


// ----------------------------------------------------------------------------- web panel service
//
// The browser half (lib/client.js) adds a "2D → 3D" panel to the dsh Web UI. It talks to
// this host half over same-origin HTTP routes registered on dsh's own web server, which
// exist only in a Web composition; headless profiles skip them.

/** noBS CAD desktop heartbeats older than this are stale (mcp-server/src/session.rs HEARTBEAT_STALE_MS). */
const HEARTBEAT_STALE_MS = 30_000

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

let statusCache = { at: 0, value: null }
function statusReport(config) {
  if (Date.now() - statusCache.at < 1000 && statusCache.value) return statusCache.value
  const value = {
    ok: true,
    checkedAt: Date.now(),
    platform: PLATFORM,
    engine: engineStatus(config),
    probe: probeStatus(config),
    desktop: desktopStatus(),
  }
  statusCache = { at: Date.now(), value }
  return value
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

const PRINT_PARAM = { type: 'string', required: true, description: 'Path of the print: a PDF, PNG or JPG file' }

/**
 * The panel's routes on dsh's web server (Web compositions only). The secret that
 * authenticates the panel is new on every boot: an index injection row writes it
 * into the page, the panel sends it back in a header, and it is never stored.
 */
function registerWebRoutes(ctx, config) {
  const token = randomBytes(24).toString('base64url')
  const handle = createRouteHandler({
    token,
    workspaces: () => ctx.workspaceRegistry.list().map((workspace) => workspace.path),
    status: () => statusReport(config),
  })
  ctx.on('webserver/index-inject', (table) => { table.push({ kind: 'global', name: PANEL_TOKEN_GLOBAL, value: token }) })
  // the web server matches a prefix route as `path === prefix || path.startsWith(prefix + '/')`
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handle }), 'nobs-cad-step: web routes')
}

export function apply(ctx, config) {
  ctx.inject(['webServer', 'workspaceRegistry'], (scoped) => registerWebRoutes(scoped, config))

  ctx.skills.register({
    name: 'nobs-cad-step',
    description: 'Turn a 2D engineering print of a flat plate part (simple or dense: notches, slots, through/counterbored/blind/tapped/edge holes, bolt circles) into a noBS CAD script and a STEP file. Load before any CAD work on a plate print.',
    whenToUse: 'The task mentions a drawing, print, PDF, scan or photo of a plate, bracket, side plate, base plate or similar flat part and asks for a 3D model, STEP, or noBS CAD script.',
    source: 'runtime',
    content: skillContent(),
    resourceBase: { kind: 'directory', path: skillDir },
  })

  ctx.tools.register(defineTool({
    name: 'nbcad_run_script',
    description: 'Run a version 1 noBS CAD .nbcad.jsonc script headlessly in a blank document and export the solid as STEP. Returns ok/steps_completed/checks_completed, the engine\'s feature summary (bodies with sizes, holes tallied by class with thread, depth and through flags), its warnings for mistakes that raise no error (a position left out of positions, overlapping holes, holes off the body, blind depths deeper than the body, unused bindings), a scene summary, the vertical holes found (x, y from the lower-left corner of the bounding box, diameter, counterbore) and the export path, or the failing step and reason with the selector candidates. Read every warning before moving on. Paths are absolute or relative to the workspace.',
    parameters: {
      script_path: { type: 'string', required: true, description: 'Path of the .nbcad.jsonc script to run' },
      step_path: { type: 'string', required: true, description: 'Path of the STEP file to write' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderJson(value),
    },
    timeoutMs: config.timeoutMs + 5000,
    async execute(args) {
      return runScript(resolveServer(config), resolvePath(args.script_path), resolvePath(args.step_path))
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
    async execute(args) {
      return inspectStep(resolveServer(config), resolvePath(args.step_path))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'nbcad_check',
    description: 'Compare your feature table with a built STEP file through the engine: expected is {bbox: [x, y, z], holes: [{x, y, diameter?, counterbore_diameter?, through?, depth?}]} in plate millimetres from the lower-left corner; the result lists matched, missing and extra holes with their offsets and whether the bounding box agrees, within tolerance_mm (default 0.6). Run it once the script builds, before the print checks: a missing or extra hole here is a script mistake, not a reading mistake.',
    parameters: {
      step_path: { type: 'string', required: true, description: 'Path of the STEP file to check' },
      expected: { type: 'object', required: true, additionalProperties: true, description: 'The expected features: {bbox: [length, width, thickness], holes: [{x, y, diameter, counterbore_diameter?, through?, depth?}]}' },
      tolerance_mm: { type: 'number', description: 'Position tolerance in mm (default 0.6)' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderJson(value),
    },
    timeoutMs: config.timeoutMs + 5000,
    async execute(args) {
      return checkStep(resolveServer(config), resolvePath(args.step_path), args.expected, args.tolerance_mm)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'nbcad_overlay_print',
    description: 'Draw the holes of a STEP file (or of a JSON hole list written by nbcad_run_script) onto the plan view of the plate print and write a PNG to look at with read_image. The plate outline is located on the page from length_mm and width_mm and its four corners are refined, so a slightly rotated scan maps correctly; plate millimetres use the lower-left corner of the plan view as origin, y up. Without region the whole plate is drawn at 150 dpi; with region "x0,y0,x1,y1" (mm) a high-resolution crop of that window is written (default 400 dpi), which is the form to check hole by hole. Red = hole at its diameter, blue = counterbore, green ticks = the millimetre grid. Every red circle must sit on a drawn hole symbol and every drawn hole symbol must carry a red circle.',
    parameters: {
      print_path: PRINT_PARAM,
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
      const holes = await holesArgument(config, args.step_path)
      const region = args.region || `-5,-5,${args.length_mm + 5},${args.width_mm + 5}`
      const dpi = args.dpi || (args.region ? 400 : 150)
      const a = ['crop', '--print', resolvePath(args.print_path), '--length', String(args.length_mm), '--width', String(args.width_mm), '--region', region, '--dpi', String(dpi), '--grid', '10', '--holes', holes, '--out', resolvePath(args.out_png)]
      if (args.page) a.push('--page', String(args.page))
      return runProbe(config, a, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'nbcad_print_probe',
    description: 'Fast pixel tools on the print (a native binary, well under a second per call after the first render; renders are cached). It reads PDF, PNG and JPG prints itself. action "render": write a PNG of the page, or of a window given as page fractions "fx0,fy0,fx1,fy1" (0..1 from the top-left corner), at the requested dpi; this is how to read callouts, chains and the title block, so zoom until every digit is unambiguous. action "info": page count and page size. The other actions need length_mm and width_mm and work in plate millimetres (origin at the lower-left corner of the plan view, y up). action "calibrate": find the plate outline on the page from length_mm and width_mm and report its corners, px_per_mm, skew, where it sits on the page (outline_page_fraction, from the top-left corner) and the drawing scale it implies (scale_ratio, a plausibility cue only, since copies are often rescaled). Give it out_png and it also writes the whole sheet with the found outline in green: view that picture once, the box must sit exactly on the plan view\'s own edges. A misread length or width makes the calibration lock onto a dimension-chain box, the edge view or a title-block cell instead, and every later result would be off. action "crop": write a PNG of a millimetre window with green tick marks every grid_mm (long tick and faint line every 5 ticks) and, when step_path is given, the model holes in red / counterbores in blue; the ticks show where a computed position falls and which symbol a leader points at, they are not a substitute for the printed dimensions. action "ring-score": for every hole of the STEP (or JSON hole list) say what is drawn at that point or within search_mm of it: symbol (a circle with a light interior, with its centre and offset in mm, its drawn diameter and counterbore), dot (a solid dot), dashed (a partial ring such as a hidden-line circle), none; run it after every script run and look at each hole with offset_mm over 1 or drawn none. action "symbols": list the circles and dots found at ink crossings in a region and match them to the model holes: model_only = model holes with no drawn symbol, print_only = drawn symbols with no model hole. Text, arrowheads and concentric rings can still appear in print_only, so treat those entries as places to look at on a crop, never as positions to model from.',
    parameters: {
      action: { type: 'string', required: true, enum: ['render', 'info', 'calibrate', 'crop', 'ring-score', 'symbols'], description: 'Which tool to run' },
      print_path: PRINT_PARAM,
      length_mm: { type: 'number', description: 'Plate length along x (the longer plan-view edge); required except for render and info' },
      width_mm: { type: 'number', description: 'Plate width along y; required except for render and info' },
      step_path: { type: 'string', description: 'STEP file (or a .json hole list written by nbcad_run_script); required for ring-score, optional for crop and symbols' },
      region: { type: 'string', description: 'Millimetre window "x0,y0,x1,y1", lower-left origin; required for crop, optional for symbols (default: the whole plate)' },
      window: { type: 'string', description: 'render: page window "fx0,fy0,fx1,fy1" as fractions of the page from its top-left corner (default: the whole page)' },
      out_png: { type: 'string', description: 'PNG to write (render and crop; optional for symbols, which then draws matched = green, model-only = red, print-only = magenta)' },
      dpi: { type: 'integer', description: 'Render resolution (render default 150, crop 400, ring-score 600, symbols 400)' },
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
      const a = [args.action, '--print', resolvePath(args.print_path)]
      const plate = !['render', 'info'].includes(args.action)
      if (plate) {
        if (args.length_mm === undefined || args.width_mm === undefined) return { ok: false, error: `${args.action} needs length_mm and width_mm` }
        a.push('--length', String(args.length_mm), '--width', String(args.width_mm))
      }
      if (args.action === 'ring-score' && !args.step_path) return { ok: false, error: 'ring-score needs step_path' }
      if (args.action === 'crop' && (!args.region || !args.out_png)) return { ok: false, error: 'crop needs region and out_png' }
      if (args.action === 'render' && !args.out_png) return { ok: false, error: 'render needs out_png' }
      if (args.step_path && plate) a.push('--holes', await holesArgument(config, args.step_path))
      if (args.region && plate) a.push('--region', args.region)
      if (args.window && args.action === 'render') a.push('--window', args.window)
      if (args.out_png) a.push('--out', resolvePath(args.out_png))
      if (args.dpi) a.push('--dpi', String(args.dpi))
      if (args.action === 'crop') a.push('--grid', String(args.grid_mm === undefined ? 10 : args.grid_mm))
      if (args.search_mm) a.push('--search', String(args.search_mm))
      if (args.page) a.push('--page', String(args.page))
      return runProbe(config, a, exec.signal)
    },
  }))
}
