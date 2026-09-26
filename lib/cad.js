/**
 * Headless noBS CAD helpers shared by the tools: run a script, export STEP,
 * re-import a STEP, and summarise the scene (bounding box, faces, vertical holes).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { McpClient } from './mcp-client.js'

function stripExtension(path) {
  return path.replace(/\.[^./\\]+$/, '')
}

/** Run `fn` against a fresh engine session whose stderr goes to `logPath`. */
export async function withSession(server, logPath, fn) {
  const client = new McpClient(server, { logPath })
  try {
    await client.ready
    return await fn(client)
  } finally {
    await client.close()
  }
}

export async function sceneSummary(client) {
  const scene = await client.call('solid_scene')
  const bodies = scene.bodies ?? []
  const out = { bodies: bodies.length, errors: scene.errors ?? [], body_details: [] }
  for (const body of bodies) {
    const faces = body.faces ?? []
    const mesh = body.mesh ?? {}
    const verts = mesh.positions ?? mesh.vertices
    let bbox = null
    if (Array.isArray(verts) && verts.length) {
      const flat = typeof verts[0] === 'number' ? verts : verts.flat()
      const axis = (k) => { let lo = Infinity, hi = -Infinity; for (let i = k; i < flat.length; i += 3) { if (flat[i] < lo) lo = flat[i]; if (flat[i] > hi) hi = flat[i] } return round(hi - lo, 3) }
      bbox = [axis(0), axis(1), axis(2)]
    }
    out.body_details.push({ id: body.id, faces: faces.length, planar_faces: faces.filter((f) => f.plane).length, cylindrical_faces: faces.filter((f) => f.cylinder).length, bbox })
  }
  return out
}

function round(value, digits) {
  const k = 10 ** digits
  return Math.round(value * k) / k
}

/** Vertical holes as (x, y from the body's bounding-box minimum, diameter, counterbore). */
export async function holesFromScene(client) {
  const scene = await client.call('solid_scene')
  const compare = await client.call('cad_compare_solids')
  const body = (compare.bodies ?? [])[0] ?? {}
  const mn = body.bbox_min ?? [0, 0, 0]
  const groups = []
  for (const b of scene.bodies ?? []) {
    for (const f of b.faces ?? []) {
      const c = f.cylinder
      if (!c) continue
      const axis = c.axis ?? {}
      const origin = c.origin ?? {}
      const r = c.radius
      if (Math.abs(axis.z ?? 0) < 0.9 || r === undefined || r === null) continue
      const x = origin.x, y = origin.y
      const group = groups.find((g) => Math.abs(g.x - x) < 0.3 && Math.abs(g.y - y) < 0.3)
      if (group) group.radii.push(r)
      else groups.push({ x, y, radii: [r] })
    }
  }
  groups.sort((a, b) => a.y - b.y || a.x - b.x)
  const holes = groups.map((g) => {
    const rad = [...g.radii].sort((a, b) => a - b)
    return { x: round(g.x - mn[0], 2), y: round(g.y - mn[1], 2), diameter: round(2 * rad[0], 2), counterbore: rad.length > 1 ? round(2 * rad[rad.length - 1], 2) : null }
  })
  return { bbox_min: mn, bbox_max: body.bbox_max ?? null, holes }
}

export async function exportStep(client, path) {
  const result = await client.call('solid_export_step', {})
  const data = Buffer.from(result.bytes_base64, 'base64')
  writeFileSync(path, data)
  return { path, bytes: data.length, is_step: data.subarray(0, 9).toString('latin1') === 'ISO-10303' }
}

function message(error) {
  return String(error?.message ?? error).slice(0, 4000)
}

/** Run a version 1 .nbcad.jsonc script in a blank document and export STEP; the same JSON the model has always seen. */
export async function runScript(server, scriptPath, stepPath) {
  const result = { ok: false, script: scriptPath, step: stepPath }
  try {
    const source = readFileSync(scriptPath, 'utf8')
    await withSession(server, stripExtension(stepPath) + '.mcp.log', async (client) => {
      const run = await client.call('cad_interface', { action: 'script', source, mode: 'fast' })
      Object.assign(result, { ok: true, steps_completed: run.steps_completed, checks_completed: run.checks_completed, elapsed_ms: run.elapsed_ms })
      result.scene = await sceneSummary(client)
      result.holes = await holesFromScene(client)
      result.export = await exportStep(client, stepPath)
    })
  } catch (error) {
    result.ok = false
    result.error = message(error)
  }
  return result
}

/** Re-import a STEP file and report the same summary. */
export async function inspectStep(server, stepPath) {
  const result = { ok: false, step: stepPath }
  try {
    await withSession(server, stripExtension(stepPath) + '.inspect.log', async (client) => {
      const catalog = await client.interface('catalog')
      const groups = {}
      for (const g of catalog.groups ?? []) for (const op of g.operations ?? []) groups[op] = g.id
      await client.interface('execute', { group: groups.solid_import_step, operation: 'solid_import_step', arguments: { file_name: basename(stepPath), data_base64: readFileSync(stepPath).toString('base64') } })
      result.ok = true
      result.scene = await sceneSummary(client)
      result.holes = await holesFromScene(client)
    })
  } catch (error) {
    result.ok = false
    result.error = message(error)
  }
  return result
}
