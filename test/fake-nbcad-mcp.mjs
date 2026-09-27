// A stand-in for nbcad-mcp over stdio: canned answers for what the plugin's helpers call,
// so the host code can be exercised on machines without a noBS CAD build.
import { createInterface } from 'node:readline'
const STEP = 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n'
const scene = { bodies: [{ id: 1, faces: [
  { id: 1, plane: { normal: [0, 0, 1], origin: [0, 0, 8] } }, { id: 2, plane: { normal: [0, 0, -1], origin: [0, 0, 0] } },
  { id: 3, cylinder: { axis: { x: 0, y: 0, z: 1 }, origin: { x: 12, y: 12, z: 0 }, radius: 3.3 } },
  { id: 4, cylinder: { axis: { x: 0, y: 0, z: 1 }, origin: { x: 12, y: 12, z: 0 }, radius: 5.5 } },
  { id: 5, cylinder: { axis: { x: 0, y: 0, z: 1 }, origin: { x: 100, y: 25, z: 0 }, radius: 2.5 } },
], mesh: { positions: [0, 0, 0, 160, 50, 8] } }], errors: [] }
const answers = {
  solid_scene: () => scene,
  cad_compare_solids: () => ({ bodies: [{ bbox_min: [0, 0, 0], bbox_max: [160, 50, 8] }] }),
  solid_export_step: () => ({ bytes_base64: Buffer.from(STEP).toString('base64') }),
  cad_interface: (a) => {
    if (a.action === 'catalog') return { groups: [{ id: 'solid/io', operations: ['solid_import_step'] }] }
    if (a.action === 'execute') return { ok: true }
    if (a.action === 'script') return { steps_completed: 3, checks_completed: 1, elapsed_ms: 5, summary: { hole_count: 2 }, warnings: [{ code: 'holes_overlap', message: 'x' }, { code: 'unused_binding', message: 'y' }] }
    if (a.action === 'check') return { bbox: { ok: true }, holes: { matched: [1, 2], missing: [], extra: [] } }
    return { status: 'failed', error: `unknown action ${a.action}` }
  },
}
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line) } catch { return }
  if (m.id === undefined) return
  let result
  if (m.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '0' } }
  else if (m.method === 'tools/list') result = { tools: Object.keys(answers).map((name) => ({ name })) }
  else if (m.method === 'tools/call') {
    const fn = answers[m.params.name]
    result = fn ? { content: [{ type: 'text', text: JSON.stringify(fn(m.params.arguments || {})) }] } : { isError: true, content: [{ type: 'text', text: 'no such tool' }] }
  } else result = {}
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n')
})
