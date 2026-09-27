---
name: nbcad-plate
description: Turn a 2D engineering print of a flat plate part (simple or dense: notches, slots, through, counterbored, blind, tapped and edge-drilled holes, bolt circles) into a noBS CAD script and a STEP file. Load before any CAD work on a plate print.
---

# Plate prints to noBS CAD scripts and STEP

Millimetres throughout. Works for a ten-hole bracket and for a dense plate with
eighty holes; the difference is only how many hole groups the inventory has and
how many script runs you allow yourself.

## Tools

- `nbcad_run_script(script_path, step_path)` runs a version 1 `.nbcad.jsonc`
  script headlessly in a blank document, exports STEP, and returns the scene
  summary (bounding box, planar and cylindrical face counts) plus the vertical
  holes it finds (x, y from the lower-left corner, diameter, counterbore). On
  failure it returns the failing step and the reason.
  The result also carries the engine's own feature summary (holes tallied by
  class with thread, depth and through flags) and its warnings for mistakes
  that raise no error: a first point left out of `positions`, overlapping
  holes, holes off the body, blind depths deeper than the body, unused
  bindings. Read every warning; a warning is a mistake to fix, not a note.
- `nbcad_inspect_step(step_path)` re-imports a STEP and returns the same summary.
- `nbcad_check(step_path, expected, tolerance_mm?)` compares your feature
  table (`{bbox: [L, W, T], holes: [{x, y, diameter, counterbore_diameter?,
  through?, depth?}]}`) with the built STEP through the engine and lists the
  matched, missing and extra holes with offsets. Run it right after a
  successful script run: a miss here is a script mistake, not a reading one.
- `nbcad_overlay_print(print_path, step_path, out_png, length_mm, width_mm, region?, dpi?)`
  draws the holes of a STEP file onto the plan view of the print (red = hole,
  blue = counterbore, green ticks = the millimetre grid) and writes a PNG; with
  `region: "x0,y0,x1,y1"` in millimetres it writes a 400 dpi crop of that
  window. View the PNG with your image tool.
- `nbcad_print_probe(action, print_path, ...)` is the fast native pixel toolkit
  (under a second per call once the page is rendered, so use it freely instead
  of writing your own pixel scripts). It reads PDF, PNG and JPG prints itself;
  nothing else is installed on the machine, so never call `pdftoppm`, Python or
  ImageMagick. `render` writes a PNG of the page or of a `window` given as
  page fractions `"fx0,fy0,fx1,fy1"` (0 to 1 from the top-left corner) at any
  dpi: that is how you read the sheet. `info` gives the page count and size.
  The plate actions take `length_mm` and `width_mm`: `crop` writes a
  millimetre window with a 10 mm tick grid, to see where a computed position
  falls and which symbol a leader points at, never to measure a coordinate;
  `ring-score` says, for every hole of a STEP, what is drawn at that point or
  within 2.5 mm (symbol with its centre and offset, dot, dashed, none);
  `symbols` lists the circles and dots found in a region and which model
  holes or drawn symbols are unmatched; `calibrate` reports the plate outline
  and skew. Run `ring-score` after every script run and look at each hole
  reported with an offset over 1 mm or nothing drawn. Treat `symbols` output
  as places to look at on a crop, never as positions to model from.
- The example script `{{SKILL_DIR}}/plate-example.nbcad.jsonc` runs cleanly and
  shows every idiom below. Read it once, then copy its structure and change only
  the numbers and the list of feature steps. Its twin
  `{{SKILL_DIR}}/plate-example-chains.nbcad.jsonc` builds the same plate with
  construction chains instead of coordinates (section 5b); read that one when
  the print dimensions holes from the edges and in chains.
- Reading the print: a scan has no text layer. Start with `render` of the whole
  page at 100 dpi to see the layout, then `render` windows at 300 to 600 dpi and
  view them; zoom until every digit is unambiguous (a faint decimal point is
  common: 6.60 can look like 6 60). Pixel measurement is for disambiguation
  only, never a substitute for a printed number, and the title-block scale must
  not be used to measure anything.
- The printed dimensions are the design; the drawing is not to scale and a
  pixel is worth half a millimetre at best, with no tolerance in it. A hole
  position comes from printed dimensions and the pattern rules of section 4,
  never from measuring. The drawn hole symbol (a small circle with a crosshair,
  or an X-marked circle for a tapped hole) tells you which hole a callout
  belongs to and confirms a computed position; it is never the source of a
  coordinate. Never take positions from a circle detector, from the tick grid,
  or from a script you wrote over the raster: digits, characters, arrowheads
  and the ends of leaders are ring-shaped too, and a hole placed on a callout's
  text is the most common error on dense prints.

## 1. Survey the sheet

Identify the plan view (the large outline with the hole callouts), the edge or
side view (thickness, holes drilled into edges) and any section view. Note part
name, material and the technical notes (edge breaks, plating, finish) for the
report; they are not geometry.

Read the outline length and width from the printed overall dimensions of the
plan view (the longest chain along each edge, for example `920` and `410`),
never from the title block and never by measuring. Then run `calibrate` with
them and `out_png`, and view the picture it writes: the green box must sit
exactly on the plan view's own edges. A box that reaches up into the dimension
chains, that covers the edge view, or that sits on a title-block cell means
the length or width you gave is wrong: re-read the overall dimensions before
doing anything else, because every crop, ring-score and overlay is measured
from this calibration. `scale_ratio` is only a plausibility cue; copies are
often rescaled, so it need not equal the title block.

Counterbore direction: a solid double circle in the plan view is visible from
the front, so the counterbore is on the top face; a dashed circle or a `背面`
note means the back face. A section view confirms it. Chinese prints are
first-angle projection.

## 2. Callout inventory, before any coordinate

List every callout on the sheet as a group with an id. Conventions:

| callout | meaning |
|---|---|
| `n × Ø d 完全贯穿` / `贯穿` / `通` | n through holes of diameter d |
| `沉头 Ø D ↧ h` | counterbore diameter D, depth h |
| `背面` | the feature starts from the back (bottom) face |
| `M6-6H ↧ 12` | tapped M6, thread depth 12; drill the tap-drill diameter 3 mm deeper than the thread |
| `Ø d ↧ h` | blind hole depth h; a depth larger than the thickness on a plate is a print error, model it through |
| `2X4 - M8` | two groups of four (usually one group per bore, mirrored) |
| `Ø54 +0.030/+0.010`, `±0.2` | fit or tolerance: model the nominal, note the tolerance |
| `2-R12.5` with a width | a slot with end radius 12.5 |
| `n-R5` | corner fillets: report, do not model |
| callouts on the edge view | holes drilled into that edge, at mid-thickness unless dimensioned |

Tap drills: M3 2.5, M4 3.3, M5 4.2, M6 5.0, M8 6.8, M10 8.5, M12 10.2, M16 14.0.

Sum the counts: that is the number of holes the finished part must have. A
group whose position you cannot resolve is still modelled, at the best estimate
you can defend, and marked UNCERTAIN with the alternatives. Omission is never an
option; uncertainty goes into the table.

## 3. Coordinate frame

Origin at the lower-left corner of the plan view, x to the right, y up, z along
the thickness. Top face z = T, bottom face z = 0, side faces x = 0, x = L,
y = 0, y = W. Every printed chain then converts directly.

## 4. Positions from chains, group by group

Write the callout inventory and this chain table before any probe action other
than `info`, `render` and `calibrate`; the pixel actions come after the numbers,
to check them. Every coordinate in the table cites the printed dimensions it
was computed from. When neither a printed dimension nor a pattern rule gives a
coordinate, model the hole at the best reading you can defend and mark it
UNCERTAIN (measured) with the alternatives; a measured value is never written
up as a read one.

- Chain from an edge: add the segments; partial chains must sum to the overall
  length or width, and a chain that ends on a hole gives that hole's coordinate.
- Symmetric pair with span s about the plate: (L − s) / 2 and (L + s) / 2.
- Linear array: start + k · pitch for k = 0 … n − 1 (for example 8 × M3 at
  25 pitch beginning 10 from an edge).
- Bolt circle around a bore at (cx, cy) with diameter D and angles θ:
  x = cx + (D / 2) cos θ, y = cy + (D / 2) sin θ. A second ring is usually
  offset by 45°; a second bore repeats the whole pattern at its own centre.
- Mirrored or repeated groups: the same offsets from the second centre.
- Parenthesised dimensions are reference values: use them to check, not to drive.
- Edge holes: x along the edge from the edge view's chain, z = T / 2.
- Write the arithmetic down in the feature table with the checks: chain sums,
  symmetry, and the count per group.

## 5. Build one script

Structure = the example. Idioms, all present in the example:

- Outline: `sketch_add_rectangle_locked` from (0, 0) to (L, W), a `fix`
  constraint on the (0, 0) point, `sketch_finish`, `solid_extrude` by T as
  `new_body`, then the `plate_feature` and `plate_body` bindings.
- Notch or step: a second sketch on the same `xy` plane with a rectangle
  covering the material to remove (it may overhang the edge), then
  `solid_extrude` with `operation: "cut"`, `extent: {"type": "through_all"}`,
  `target_body_ids` = the plate body.
- Slot: `sketch_add_slot` with `mode: "center_to_center"`, `p1` and `p2` = the
  two arc centres, `cursor` = any point beside the slot, `width_mm` = the slot
  width, then the same cut extrude.
- Face selectors (bind before each hole step from the previous step's result):
  top `{"/plane/normal/2": 1, "/plane/origin/2": T}`, bottom
  `{"/plane/normal/2": -1, "/plane/origin/2": 0}`, side faces by normal only:
  `{"/plane/normal/1": -1}` is the y = 0 edge, `{"/plane/normal/1": 1}` the
  y = W edge, `{"/plane/normal/0": -1}` x = 0, `{"/plane/normal/0": 1}` x = L.
  Both tests on top and bottom are required because a counterbore floor also
  faces ±z. If a notch splits an edge face, add `/plane/origin/0` (the piece's
  centre x) to pick one piece.
- Holes: `solid_hole` with `position` = `{"$project": {"point": [x, y, z],
  "basis": {"$ref": "<face>", "pointer": "/plane"}}}` where z = T on the top
  face and 0 on the bottom; on a side face project the point on that face, for
  example `[x, 0, z]` on the y = 0 edge. One call per callout group: the first
  point in `position`, and every point of the group, the first one included,
  in `positions`; when `positions` is present only its points are drilled, so
  a first point left out of it is lost silently (`ring-score` shows it). Styles: through
  `extent {"type": "through_all"}` and `style "simple"`; counterbore
  `style "counterbore"` with `counterbore_diameter` and `counterbore_depth`;
  blind `extent {"type": "distance", "depth": h}`; tapped = tap-drill diameter,
  blind extent, plus the complete `thread` block from the example (`standard`,
  `series`, `designation`, `class`, `nominal_diameter`, `pitch`,
  `threads_per_inch`, `hand`, `depth`, `representation` are all required).
- Fits and tolerances: nominal diameter, note in the report.
- Keep the `checks` from the example.

## 5b. Construction chains instead of coordinates

When a print locates holes by chains from the plate edges (the usual case on
small and medium plates), let the engine do the arithmetic the way a
draughtsman would: draw the chains as lines whose lengths are the printed
numbers and anchor each hole to the end of its chain. The idioms are all in
`plate-example-chains.nbcad.jsonc`:

- After the plate is built, bind its top face (`face(prev, "top_0", TOP)`) and
  open one sketch on it: `sketch_begin` with `plane: {"type": "planar_face",
  "face_id": {"$ref": "top_0", "pointer": "/id"}}` and
  `"face_origin": "global_origin_projection"`, so sketch x, y are plate x, y.
- One `sketch_add_line_locked` per printed dimension: `from` is a plate point
  (`{"x": 0, "y": 0}` on the datum corner, `{"x": L, "y": 0}` when the chain
  starts at the right edge) or the end of the previous line, `length_mm` is
  the printed number, `angle_deg` 0 along +x, 90 along +y, 180 along -x, 270
  along -y, and a `45°` callout is a line at 45; `to_hint` can stay
  `{"x": 1, "y": 0}`. The end of an earlier line is read back from that step:
  `{"$select": {"from": {"$ref": "<line step>", "pointer": "/sketch"}, "path":
  "/entities", "where": {"/id": {"$ref": "<line step>", "pointer":
  "/entity_id"}}, "take": "one", "pointer": "/end"}}`.
- `sketch_finish`, then holes as in section 5, but each anchor is
  `"position": {"x": 0, "y": 0}, "position_reference": {"sketch_name":
  "Chains", "entity_id": {"$ref": "<line step>", "pointer": "/entity_id"},
  "kind": "end"}`; inside `positions` every entry carries its own reference.
  `position` is required by the schema but the reference drives the centre.
  Bind the face for the first hole from the last solid step (`plate_build`),
  never from a sketch step: sketch results carry no scene.
- Bolt circles, pitched rows and symmetric spans stay on the arithmetic of
  section 4 (or mix: a chain may start at a hole located by arithmetic). A
  dimension between two holes is a chain line from the first hole's end.
- The chains stay in the file as a sketch a reviewer can open in noBS CAD and
  compare with the print line by line.
- The run result's overlap and off-body warnings are not evaluated for anchored
  holes (the engine reads the placeholder there); their positions are verified
  by `nbcad_check` on the exported STEP, which reads the built geometry.

Parser rules: every step is exactly one of `call`, `note`, `view`, `let` or
`assert`; a chapter heading goes on a `note` step that also has `"note"` text;
step ids are unique; a `$ref` names only an earlier step id or `let` binding;
JSON pointers start with `/`; numbers are plain JSON numbers.

Run policy: a simple plate needs one run plus at most one correction. A dense
plate may take up to five runs: run, read the failing step and reason, fix only
that step, run again. Probe budget: reading the sheet of a simple plate takes
about ten renders, one calibrate, and after each script run one ring-score
plus one overlay crop per hole region. Past thirty probe calls or twenty image
views on a simple plate you are measuring instead of reading: stop, go back to
the printed chains, and re-read them. A dense plate may need several times
that, still group by group. After a successful run compare the returned hole list
with the inventory (count per diameter, counterbores, edge holes appear as
extra cylindrical faces), add whatever is missing, and run again. Do not
declare the part done while a callout group is absent.

## 6. Verify and report

- Bounding box = L × W × T, one body, no scene errors.
- Holes by diameter match the inventory (tap-drill diameters for threads);
  counterbores match; edge holes counted in the cylindrical faces.
- `nbcad_inspect_step` on the exported STEP gives the same numbers, and
  `nbcad_check` with the feature table as `expected` must report no missing
  and no extra hole.
- Probe check after every script run: `nbcad_print_probe` with `ring-score`;
  every hole must come back as symbol, dot or dashed with an offset under 1 mm.
  An offset over 1 mm means a chain was misread or the symbol belongs to
  another group: re-read the printed dimension and fix the arithmetic; never
  move the hole to the measured centre unless the print gives no dimension for
  it, and then it is UNCERTAIN (measured) in the report. Then `symbols` on the
  whole plate: every print_only entry is a spot to view.
- Overlay check, mandatory before the report: run `nbcad_overlay_print` for the
  whole plate and view it, then run it with a `region` of roughly 250 × 200 mm
  for every part of the plate that holds holes and view each crop. Every red
  circle must sit on a drawn hole symbol and every drawn hole symbol must carry
  a red circle; a red circle on blank paper, on text, or beside a symbol is a
  wrong position, and a symbol without a red circle is a missing or misplaced
  hole. Fix the script, run it again and repeat the overlay until every crop is
  clean. The count matching the inventory does not prove the positions; only
  the overlay does.
- A hole symbol is a circle drawn on its own centrelines, with a crosshair or
  an X. The arrowhead of a dimension line sitting on a centreline, a leader's
  arrowhead, and the crossing of two lines are not symbols, whatever an ink
  score says; judge every doubtful spot by eye on a 600 dpi crop.
- Assign each symbol to its callout by the leader: the arrowhead identifies one
  member of the group, and the printed pattern dimensions (pitch, spacing,
  bolt circle) give the others. Never assign by nearness to the callout text,
  and never leave a symbol as "no callout found" while a callout group is short
  of members.
- Report per group: id, callout, count, diameter, style, face, positions, the
  chain used, and certainty. Then the left-out list (fillets, chamfers, edge
  breaks, finish, tolerances, GD&T) and every uncertain reading with the
  alternatives.
