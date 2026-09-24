/**
 * dsh-nbcad-plate: DeepSeek Harness plugin that turns 2D plate prints into
 * noBS CAD scripts and STEP files.
 *
 * It registers one skill, `nbcad-plate` (the standard workflow for flat plate
 * parts, simple or dense), and two model-facing tools that drive a headless
 * noBS CAD engine: `nbcad_run_script` runs a version 1 `.nbcad.jsonc` script
 * and exports STEP, `nbcad_inspect_step` re-imports a STEP file and lists its
 * bounding box and holes. Everything the model builds goes through the
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
}
