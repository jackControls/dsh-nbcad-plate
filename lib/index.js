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

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
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
