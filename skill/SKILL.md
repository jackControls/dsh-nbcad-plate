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
- `nbcad_inspect_step(step_path)` re-imports a STEP and returns the same summary.
- `nbcad_overlay_print(pdf_path, step_path, out_png, length_mm, width_mm, region?, dpi?)`
  draws the holes of a STEP file onto the plan view of the print (red = hole,
  blue = counterbore, green = the plate outline it calibrated on) and writes a
  PNG; with `region: "x0,y0,x1,y1"` in millimetres it writes a 400 dpi crop of
  that window. View the PNG with your image tool.
- The example script `{{SKILL_DIR}}/plate-example.nbcad.jsonc` runs cleanly and
  shows every idiom below. Read it once, then copy its structure and change only
  the numbers and the list of feature steps.
- Reading a scanned print: it has no text layer. Render crops with
  `pdftoppm -r 400 -x X -y Y -W W -H H -png -singlefile file.pdf out` and view
  them; zoom until every digit is unambiguous (a faint decimal point is common:
  6.60 can look like 6 60). Pixel measurement is for disambiguation only, never a
  substitute for a printed number, and the title-block scale must not be used to
  measure anything.
- A hole position comes from a printed dimension, or from the drawn hole symbol
  (a small circle with a crosshair, or an X-marked circle for a tapped hole)
  that you have seen on a crop at that spot. Never take positions from a circle
  detector or a script you wrote over the raster without looking: digits,
  characters, arrowheads and the ends of leaders are ring-shaped too, and a hole
  placed on a callout's text is the most common error on dense prints.

## 1. Survey the sheet

Identify the plan view (the large outline with the hole callouts), the edge or
side view (thickness, holes drilled into edges) and any section view. Note part
name, material and the technical notes (edge breaks, plating, finish) for the
report; they are not geometry.

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
  point in `position`, all points repeated in `positions`. Styles: through
  `extent {"type": "through_all"}` and `style "simple"`; counterbore
  `style "counterbore"` with `counterbore_diameter` and `counterbore_depth`;
  blind `extent {"type": "distance", "depth": h}`; tapped = tap-drill diameter,
  blind extent, plus the complete `thread` block from the example (`standard`,
  `series`, `designation`, `class`, `nominal_diameter`, `pitch`,
  `threads_per_inch`, `hand`, `depth`, `representation` are all required).
- Fits and tolerances: nominal diameter, note in the report.
- Keep the `checks` from the example.

Parser rules: every step is exactly one of `call`, `note`, `view`, `let` or
`assert`; a chapter heading goes on a `note` step that also has `"note"` text;
step ids are unique; a `$ref` names only an earlier step id or `let` binding;
JSON pointers start with `/`; numbers are plain JSON numbers.

Run policy: a simple plate needs one run plus at most one correction. A dense
plate may take up to five runs: run, read the failing step and reason, fix only
that step, run again. After a successful run compare the returned hole list
with the inventory (count per diameter, counterbores, edge holes appear as
extra cylindrical faces), add whatever is missing, and run again. Do not
declare the part done while a callout group is absent.

## 6. Verify and report

- Bounding box = L × W × T, one body, no scene errors.
- Holes by diameter match the inventory (tap-drill diameters for threads);
  counterbores match; edge holes counted in the cylindrical faces.
- `nbcad_inspect_step` on the exported STEP gives the same numbers.
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
