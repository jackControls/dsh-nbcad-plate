#!/usr/bin/env node
/**
 * Generate the skill's construction-line example and/or validate it through the engine.
 *
 *   node tools/make-chains-example.mjs [--write] [--validate]
 *
 * The plate is the same 160 x 50 x 12 as plate-example.nbcad.jsonc, but every hole is located
 * the way a draughtsman reads the print: a sketch on the top face holds chains of lines whose
 * lengths are the printed dimensions, starting from the plate edges, and each hole is anchored
 * to the end of its chain (position_reference), so the engine does the arithmetic.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runScript } from '../lib/cad.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'skill', 'plate-example-chains.nbcad.jsonc')
const [W, H, T] = [160, 50, 12]
const SKETCH = 'Chains'

const binding = (name, expr) => ({ let: { [name]: expr } })
const face = (prev, name, where) => binding(name, { $select: {
  from: { $select: { from: { $ref: prev }, path: '/scene/bodies', where: { '/id': { $ref: 'plate_body', pointer: '/id' } }, take: 'one' } },
  path: '/faces', where, take: 'one' } })
const note = (chapter, text) => ({ chapter, note: text, duration_ms: 800 })
const TOP = { '/plane/normal/2': 1, '/plane/origin/2': T }

/** The end point of an earlier chain line, read back from that step's sketch result. */
const endOf = (lineStep) => ({ $select: { from: { $ref: lineStep, pointer: '/sketch' }, path: '/entities', where: { '/id': { $ref: lineStep, pointer: '/entity_id' } }, take: 'one', pointer: '/end' } })
/** One chain line: from a plate point or the end of the previous line, a printed length along an angle. */
const line = (id, from, length, angle) => ({ id, call: { group: 'sketch/draw', operation: 'sketch_add_line_locked', arguments: {
  from, to_hint: { x: 1, y: 0 }, length_mm: length, angle_deg: angle, ctrl_held: false } } })
/** A hole anchored to the end of a chain line; the position field is required by the schema but the reference drives the centre. */
const anchor = (lineStep) => ({ position: { x: 0, y: 0 }, position_reference: { sketch_name: SKETCH, entity_id: { $ref: lineStep, pointer: '/entity_id' }, kind: 'end' } })
function hole(stepId, faceName, lineSteps, d, style = 'simple', cbD = 0, cbDepth = 0, extent = null, thread = null) {
  const args = {
    body_id: { $ref: 'plate_body', pointer: '/id' }, face_id: { $ref: faceName, pointer: '/id' },
    ...anchor(lineSteps[0]),
    diameter: d, extent: extent ?? { type: 'through_all' }, style,
    counterbore_diameter: cbD, counterbore_depth: cbDepth, countersink_diameter: 0, countersink_angle_deg: 90, flip: false,
  }
  if (lineSteps.length > 1) args.positions = lineSteps.map((l) => anchor(l))
  if (thread) args.thread = thread
  return { id: stepId, call: { group: 'solid/refine', operation: 'solid_hole', arguments: args } }
}
const M4 = { standard: 'iso_metric', series: 'metric_coarse', designation: 'M4', class: '6H', nominal_diameter: 4, pitch: 0.7, threads_per_inch: null, hand: 'right', depth: 6, representation: 'simplified' }

const steps = [
  note('Stock plate', 'Plate 160 x 50 x 12 mm, the same part as plate-example.nbcad.jsonc. Origin at the lower-left corner of the plan view, y up, thickness along +z.'),
  { id: 'plate_begin', call: { group: 'sketch/draw', operation: 'sketch_begin', arguments: { name: 'Plate outline', plane: { type: 'origin_plane', plane: 'xy' } } } },
  { id: 'plate_rectangle', call: { group: 'sketch/draw', operation: 'sketch_add_rectangle_locked', arguments: { mode: 'two_point', anchor: { x: 0, y: 0 }, corner_hint: { x: W, y: H }, width_mm: W, height_mm: H, ctrl_held: true } } },
  { id: 'plate_locate', call: { group: 'sketch/constrain', operation: 'sketch_add_constraint', arguments: { type: 'fix', entity: { $select: { from: { $ref: 'plate_rectangle', pointer: '/sketch' }, path: '/entities', where: { '/kind': 'point', '/position/x': 0, '/position/y': 0 }, take: 'one', pointer: '/id' } } } } },
  { id: 'plate_finish', call: { group: 'sketch/draw', operation: 'sketch_finish', arguments: {} } },
  { id: 'plate_build', call: { group: 'solid/build', operation: 'solid_extrude', arguments: { sketch_name: 'Plate outline', profile_indices: [0], operation: 'new_body', extent: { type: 'distance', distance: T }, taper_angle_deg: 0, flip: false, target_body_ids: [] } } },
  binding('plate_feature', { $select: { from: { $ref: 'plate_build' }, path: '/document/features', take: 'last', pointer: '/id' } }),
  binding('plate_body', { $select: { from: { $ref: 'plate_build' }, path: '/scene/bodies', where: { '/feature_id': { $ref: 'plate_feature' } }, take: 'one' } }),
  note('Chains on the top face', 'One sketch on the top face, with sketch zero at the projected global origin so sketch x, y are plate x, y. Every printed dimension becomes one line of that length: a chain starts at a plate edge point (x = 0 or y = 0 is a datum edge, x = 160 or y = 50 the opposite edge) and each further line starts at the end of the previous one, read back from that step with a selector. Angle 0 runs along +x, 90 along +y, 180 along -x, 270 along -y; a 45 degree callout is a line at 45.'),
  face('plate_build', 'top_0', TOP),
  { id: 'chains_begin', call: { group: 'sketch/draw', operation: 'sketch_begin', arguments: { name: SKETCH, plane: { type: 'planar_face', face_id: { $ref: 'top_0', pointer: '/id' } }, face_origin: 'global_origin_projection' } } },
  // corner counterbores: "12" from the left edge and "12" from the bottom edge; the right one "12" from the right edge
  line('cb_left_x', { x: 0, y: 0 }, 12, 0),
  line('cb_left_y', endOf('cb_left_x'), 12, 90),
  line('cb_right_x', { x: W, y: 0 }, 12, 180),
  line('cb_right_y', endOf('cb_right_x'), 12, 90),
  // the bore: "40" from the left edge on the plate centre line "25" up
  line('bore_x', { x: 0, y: 0 }, 40, 0),
  line('bore_y', endOf('bore_x'), 25, 90),
  // two small counterbores on the same centre line: "60" from the left edge, then "40" further
  line('small_x', { x: 0, y: 0 }, 60, 0),
  line('small_y', endOf('small_x'), 25, 90),
  line('small_pitch', endOf('small_y'), 40, 0),
  // a hole called out at 45 degrees from the bore centre: "20" along the 45 degree line
  line('diag', endOf('bore_y'), 20, 45),
  // a blind hole "75" from the left edge, "12" up
  line('blind_x', { x: 0, y: 0 }, 75, 0),
  line('blind_y', endOf('blind_x'), 12, 90),
  { id: 'chains_finish', call: { group: 'sketch/draw', operation: 'sketch_finish', arguments: {} } },
  note('Holes anchored to chain ends', 'Each hole step names the chain line whose end is its centre (position_reference with kind end). One call per callout group, the first anchor repeated inside positions, like the coordinate idiom. The face is bound from the last solid step: a sketch step carries no scene.'),
  face('plate_build', 'top_1', TOP),
  hole('corner_cbores', 'top_1', ['cb_left_y', 'cb_right_y'], 6.6, 'counterbore', 11, 6.5),
  face('corner_cbores', 'top_2', TOP),
  hole('bore', 'top_2', ['bore_y'], 20),
  face('bore', 'top_3', TOP),
  hole('small_cbores', 'top_3', ['small_y', 'small_pitch'], 4.5, 'counterbore', 8, 4.6),
  face('small_cbores', 'top_4', TOP),
  hole('diag_m4', 'top_4', ['diag'], 3.3, 'simple', 0, 0, { type: 'distance', depth: 9 }, M4),
  face('diag_m4', 'top_5', TOP),
  hole('blind', 'top_5', ['blind_y'], 5, 'simple', 0, 0, { type: 'distance', depth: 5 }),
  { view: 'isometric', fit: true, body_id: { $ref: 'plate_body', pointer: '/id' }, duration_ms: 350 },
]
const script = {
  version: 1, name: 'Example plate located by construction chains', starting_state: 'empty', steps,
  checks: [
    { id: 'final_scene', call: { group: 'solid/check', operation: 'solid_scene', arguments: {} } },
    { assert: { $ref: 'final_scene', pointer: '/errors' }, equals: [] },
    { assert: { $count: { $ref: 'final_scene', pointer: '/bodies' } }, equals: 1 },
  ],
}
const header = '// The plate of plate-example.nbcad.jsonc located the way the print is read: a sketch of\n'
  + '// construction chains on the top face, one line per printed dimension starting from a plate\n'
  + '// edge, and every hole anchored to the end of its chain. No coordinate arithmetic; the engine\n'
  + '// adds the lengths. Millimetres; origin at the lower-left corner of the plan view, y up.\n'

const argv = process.argv.slice(2)
if (argv.includes('--write')) {
  const source = header + JSON.stringify(script, null, 2) + '\n'
  writeFileSync(OUT, source)
  console.log('written', OUT, source.length, 'chars')
}
if (argv.includes('--validate')) {
  const server = process.env.NBCAD_MCP || 'nbcad-mcp'
  const step = join(ROOT, 'tools', 'chains-validate.step')
  const value = await runScript(server, OUT, step)
  if (!value.ok) { console.log('VALIDATION FAILED:', value.error); process.exit(1) }
  console.log('steps:', value.steps_completed, 'checks:', value.checks_completed, '| scene:', JSON.stringify(value.scene))
  console.log('holes:', JSON.stringify(value.holes.holes))
  const expect = [[12, 12], [148, 12], [40, 25], [60, 25], [100, 25], [40 + 20 * Math.SQRT1_2, 25 + 20 * Math.SQRT1_2], [75, 12]]
  const got = value.holes.holes
  const missing = expect.filter(([x, y]) => !got.some((h) => Math.abs(h.x - x) < 0.02 && Math.abs(h.y - y) < 0.02))
  console.log(missing.length ? 'MISSING expected centres: ' + JSON.stringify(missing) : 'every expected centre present')
  if (value.warnings) console.log('warnings:', JSON.stringify(value.warnings))
}
if (!argv.includes('--write') && !argv.includes('--validate')) console.log(readFileSync(OUT, 'utf8').length, 'chars in', OUT, '(use --write and/or --validate)')
