#!/usr/bin/env node
/**
 * Generate the skill's example script and/or validate it through the engine.
 *
 *   node tools/make-example.mjs [--write] [--validate]
 *
 * --write regenerates skill/plate-example.nbcad.jsonc; --validate runs the file through a
 * headless noBS CAD engine (config: NBCAD_MCP or `nbcad-mcp` on PATH) and prints the summary.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runScript } from '../lib/cad.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'skill', 'plate-example.nbcad.jsonc')
const [W, H, T] = [160, 50, 8]

const binding = (name, expr) => ({ let: { [name]: expr } })
const face = (prev, name, where) => binding(name, { $select: {
  from: { $select: { from: { $ref: prev }, path: '/scene/bodies', where: { '/id': { $ref: 'plate_body', pointer: '/id' } }, take: 'one' } },
  path: '/faces', where, take: 'one' } })
const project = (faceName, point) => ({ $project: { point: [...point], basis: { $ref: faceName, pointer: '/plane' } } })

function hole(stepId, faceName, points, d, style = 'simple', cbD = 0, cbDepth = 0, extent = null, thread = null) {
  const args = {
    body_id: { $ref: 'plate_body', pointer: '/id' }, face_id: { $ref: faceName, pointer: '/id' },
    position: project(faceName, points[0]),
    diameter: d, extent: extent ?? { type: 'through_all' }, style,
    counterbore_diameter: cbD, counterbore_depth: cbDepth, countersink_diameter: 0, countersink_angle_deg: 90, flip: false,
  }
  if (points.length > 1) args.positions = points.map((p) => ({ position: project(faceName, p) }))
  if (thread) args.thread = thread
  return { id: stepId, call: { group: 'solid/refine', operation: 'solid_hole', arguments: args } }
}

const rectangle = (prefix, name, x0, y0, w, h) => [
  { id: `${prefix}_begin`, call: { group: 'sketch/draw', operation: 'sketch_begin', arguments: { name, plane: { type: 'origin_plane', plane: 'xy' } } } },
  { id: `${prefix}_rectangle`, call: { group: 'sketch/draw', operation: 'sketch_add_rectangle_locked', arguments: { mode: 'two_point', anchor: { x: x0, y: y0 }, corner_hint: { x: x0 + w, y: y0 + h }, width_mm: w, height_mm: h, ctrl_held: true } } },
  { id: `${prefix}_locate`, call: { group: 'sketch/constrain', operation: 'sketch_add_constraint', arguments: { type: 'fix', entity: { $select: { from: { $ref: `${prefix}_rectangle`, pointer: '/sketch' }, path: '/entities', where: { '/kind': 'point', '/position/x': x0, '/position/y': y0 }, take: 'one', pointer: '/id' } } } } },
  { id: `${prefix}_finish`, call: { group: 'sketch/draw', operation: 'sketch_finish', arguments: {} } },
]
const cut = (prefix, name) => ({ id: `${prefix}_cut`, call: { group: 'solid/build', operation: 'solid_extrude', arguments: { sketch_name: name, profile_indices: [0], operation: 'cut', extent: { type: 'through_all' }, taper_angle_deg: 0, flip: false, target_body_ids: [{ $ref: 'plate_body', pointer: '/id' }] } } })
const note = (chapter, text) => ({ chapter, note: text, duration_ms: 800 })

const M4 = { standard: 'iso_metric', series: 'metric_coarse', designation: 'M4', class: '6H', nominal_diameter: 4, pitch: 0.7, threads_per_inch: null, hand: 'right', depth: 6, representation: 'simplified' }
const M6 = { standard: 'iso_metric', series: 'metric_coarse', designation: 'M6', class: '6H', nominal_diameter: 6, pitch: 1.0, threads_per_inch: null, hand: 'right', depth: 10, representation: 'simplified' }
const BORE = [40, 25]
const round4 = (v) => Math.round(v * 1e4) / 1e4
const BOLT_CIRCLE = [45, 135, 225, 315].map((a) => [round4(BORE[0] + 16 * Math.cos(a * Math.PI / 180)), round4(BORE[1] + 16 * Math.sin(a * Math.PI / 180))])
const TOP = { '/plane/normal/2': 1, '/plane/origin/2': T }
const BOTTOM = { '/plane/normal/2': -1, '/plane/origin/2': 0 }
const EDGE_Y0 = { '/plane/normal/1': -1 }

const steps = [
  note('Stock plate', "Plate 160 x 50 x 8 mm. Origin at the lower-left corner of the plan view, y up, thickness along +z, so every position is read straight off the print's chains."),
  ...rectangle('plate', 'Plate outline', 0, 0, W, H),
  { id: 'plate_build', call: { group: 'solid/build', operation: 'solid_extrude', arguments: { sketch_name: 'Plate outline', profile_indices: [0], operation: 'new_body', extent: { type: 'distance', distance: T }, taper_angle_deg: 0, flip: false, target_body_ids: [] } } },
  binding('plate_feature', { $select: { from: { $ref: 'plate_build' }, path: '/document/features', take: 'last', pointer: '/id' } }),
  binding('plate_body', { $select: { from: { $ref: 'plate_build' }, path: '/scene/bodies', where: { '/feature_id': { $ref: 'plate_feature' } }, take: 'one' } }),
  note('Notch in the outline', 'A notch or step is a second sketch on the same origin plane, cut through all; its rectangle may overhang the edge.'),
  ...rectangle('notch', 'Notch', 60, 40, 40, 15),
  cut('notch', 'Notch'),
  note('Slot', 'A slot is sketch_add_slot center_to_center between the two arc centres with the slot width, then the same cut.'),
  { id: 'slot_begin', call: { group: 'sketch/draw', operation: 'sketch_begin', arguments: { name: 'Slot', plane: { type: 'origin_plane', plane: 'xy' } } } },
  { id: 'slot_shape', call: { group: 'sketch/draw', operation: 'sketch_add_slot', arguments: { mode: 'center_to_center', p1: { x: 115, y: 14 }, p2: { x: 115, y: 36 }, cursor: { x: 118, y: 25 }, width_mm: 6 } } },
  { id: 'slot_finish', call: { group: 'sketch/draw', operation: 'sketch_finish', arguments: {} } },
  cut('slot', 'Slot'),
  note('Holes from the top face', 'Bind the current top face (normal +z and plane origin z = thickness) before each hole step; project the design point (x, y, T) into its basis. One call per callout group with positions.'),
  face('slot_cut', 'top_0', TOP),
  hole('corner_cbores', 'top_0', [[12, 12, T], [148, 12, T]], 6.6, 'counterbore', 11, 6.5),
  face('corner_cbores', 'top_1', TOP),
  hole('small_cbores', 'top_1', [[60, 25, T], [100, 25, T]], 4.5, 'counterbore', 8, 4.6),
  face('small_cbores', 'top_2', TOP),
  hole('bore', 'top_2', [[BORE[0], BORE[1], T]], 20),
  note('Bolt circle', 'Four M4 on a 32 mm circle around the bore at 45, 135, 225 and 315 degrees: x = cx + 16 cos(a), y = cy + 16 sin(a).'),
  face('bore', 'top_3', TOP),
  hole('bolt_circle_m4', 'top_3', BOLT_CIRCLE.map(([x, y]) => [x, y, T]), 3.3, 'simple', 0, 0, { type: 'distance', depth: 9 }, M4),
  note('Holes from the bottom face', 'A counterbore called out 背面 starts from the bottom face (normal -z, origin z = 0); project the point with z = 0.'),
  face('bolt_circle_m4', 'bottom_0', BOTTOM),
  hole('back_cbore', 'bottom_0', [[130, 38, 0]], 6.6, 'counterbore', 11, 4),
  note('Blind hole', 'A blind hole uses extent distance with the drilled depth.'),
  face('back_cbore', 'top_4', TOP),
  hole('blind', 'top_4', [[75, 12, T]], 5, 'simple', 0, 0, { type: 'distance', depth: 5 }),
  note('Hole drilled into an edge', 'Bind the edge face by its normal (y = 0 edge here) and project a point on that face at mid-thickness: [x, 0, T/2]. The drill goes into the material by default.'),
  face('blind', 'edge_y0', EDGE_Y0),
  hole('edge_m6', 'edge_y0', [[20, 0, T / 2]], 5, 'simple', 0, 0, { type: 'distance', depth: 13 }, M6),
  { view: 'isometric', fit: true, body_id: { $ref: 'plate_body', pointer: '/id' }, duration_ms: 350 },
]
const script = {
  version: 1, name: 'Example plate with every idiom', starting_state: 'empty', steps,
  checks: [
    { id: 'final_scene', call: { group: 'solid/check', operation: 'solid_scene', arguments: {} } },
    { assert: { $ref: 'final_scene', pointer: '/errors' }, equals: [] },
    { assert: { $count: { $ref: 'final_scene', pointer: '/bodies' } }, equals: 1 },
  ],
}
const header = '// Example flow for a flat plate part: located outline, one extrusion, a notch cut, a slot,\n'
  + '// counterbored holes from the top and the bottom face, a bore with a tapped bolt circle,\n'
  + '// a blind hole and a tapped hole drilled into an edge. Millimetres. Origin: lower-left corner\n'
  + '// of the plan view, y up, z = thickness.\n'

const argv = process.argv.slice(2)
if (argv.includes('--write')) {
  const source = header + JSON.stringify(script, null, 2) + '\n'
  writeFileSync(OUT, source)
  console.log('written', OUT, source.length, 'chars')
}
if (argv.includes('--validate')) {
  const server = process.env.NBCAD_MCP || 'nbcad-mcp'
  const step = join(ROOT, 'tools', 'example-validate.step')
  const value = await runScript(server, OUT, step)
  if (!value.ok) { console.log('VALIDATION FAILED:', value.error); process.exit(1) }
  console.log('steps:', value.steps_completed, 'checks:', value.checks_completed, '| scene:', JSON.stringify(value.scene))
  console.log('holes:', JSON.stringify(value.holes.holes))
  console.log('export:', JSON.stringify(value.export))
}
if (!argv.includes('--write') && !argv.includes('--validate')) console.log(readFileSync(OUT, 'utf8').length, 'chars in', OUT, '(use --write and/or --validate)')
