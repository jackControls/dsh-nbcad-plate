"""Generate the skill's example script and validate it through the engine.

  python3 tools/make_example.py [--validate]
"""
import json
import math
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
W, H, T = 160, 50, 8


def binding(name, expr):
    return {"let": {name: expr}}


def face(prev, name, where):
    return binding(name, {"$select": {
        "from": {"$select": {"from": {"$ref": prev}, "path": "/scene/bodies", "where": {"/id": {"$ref": "plate_body", "pointer": "/id"}}, "take": "one"}},
        "path": "/faces", "where": where, "take": "one"}})


def project(face_name, point):
    return {"$project": {"point": list(point), "basis": {"$ref": face_name, "pointer": "/plane"}}}


def hole(step_id, face_name, points, d, style="simple", cb_d=0, cb_depth=0, extent=None, thread=None):
    arguments = {
        "body_id": {"$ref": "plate_body", "pointer": "/id"}, "face_id": {"$ref": face_name, "pointer": "/id"},
        "position": project(face_name, points[0]),
        "diameter": d, "extent": extent or {"type": "through_all"}, "style": style,
        "counterbore_diameter": cb_d, "counterbore_depth": cb_depth, "countersink_diameter": 0, "countersink_angle_deg": 90, "flip": False,
    }
    if len(points) > 1:
        arguments["positions"] = [{"position": project(face_name, p)} for p in points]
    if thread:
        arguments["thread"] = thread
    return {"id": step_id, "call": {"group": "solid/refine", "operation": "solid_hole", "arguments": arguments}}


def rectangle(prefix, name, x0, y0, w, h):
    return [
        {"id": f"{prefix}_begin", "call": {"group": "sketch/draw", "operation": "sketch_begin", "arguments": {"name": name, "plane": {"type": "origin_plane", "plane": "xy"}}}},
        {"id": f"{prefix}_rectangle", "call": {"group": "sketch/draw", "operation": "sketch_add_rectangle_locked", "arguments": {"mode": "two_point", "anchor": {"x": x0, "y": y0}, "corner_hint": {"x": x0 + w, "y": y0 + h}, "width_mm": w, "height_mm": h, "ctrl_held": True}}},
        {"id": f"{prefix}_locate", "call": {"group": "sketch/constrain", "operation": "sketch_add_constraint", "arguments": {"type": "fix", "entity": {"$select": {"from": {"$ref": f"{prefix}_rectangle", "pointer": "/sketch"}, "path": "/entities", "where": {"/kind": "point", "/position/x": x0, "/position/y": y0}, "take": "one", "pointer": "/id"}}}}},
        {"id": f"{prefix}_finish", "call": {"group": "sketch/draw", "operation": "sketch_finish", "arguments": {}}},
    ]


def cut(prefix, name):
    return {"id": f"{prefix}_cut", "call": {"group": "solid/build", "operation": "solid_extrude", "arguments": {"sketch_name": name, "profile_indices": [0], "operation": "cut", "extent": {"type": "through_all"}, "taper_angle_deg": 0, "flip": False, "target_body_ids": [{"$ref": "plate_body", "pointer": "/id"}]}}}


def note(chapter, text):
    return {"chapter": chapter, "note": text, "duration_ms": 800}


M4 = {"standard": "iso_metric", "series": "metric_coarse", "designation": "M4", "class": "6H", "nominal_diameter": 4, "pitch": 0.7, "threads_per_inch": None, "hand": "right", "depth": 6, "representation": "simplified"}
M6 = {"standard": "iso_metric", "series": "metric_coarse", "designation": "M6", "class": "6H", "nominal_diameter": 6, "pitch": 1.0, "threads_per_inch": None, "hand": "right", "depth": 10, "representation": "simplified"}
BORE = (40.0, 25.0)
BOLT_CIRCLE = [(round(BORE[0] + 16 * math.cos(math.radians(a)), 4), round(BORE[1] + 16 * math.sin(math.radians(a)), 4)) for a in (45, 135, 225, 315)]

TOP = {"/plane/normal/2": 1, "/plane/origin/2": T}
BOTTOM = {"/plane/normal/2": -1, "/plane/origin/2": 0}
EDGE_Y0 = {"/plane/normal/1": -1}

steps = [
    note("Stock plate", "Plate 160 x 50 x 8 mm. Origin at the lower-left corner of the plan view, y up, thickness along +z, so every position is read straight off the print's chains."),
    *rectangle("plate", "Plate outline", 0, 0, W, H),
    {"id": "plate_build", "call": {"group": "solid/build", "operation": "solid_extrude", "arguments": {"sketch_name": "Plate outline", "profile_indices": [0], "operation": "new_body", "extent": {"type": "distance", "distance": T}, "taper_angle_deg": 0, "flip": False, "target_body_ids": []}}},
    binding("plate_feature", {"$select": {"from": {"$ref": "plate_build"}, "path": "/document/features", "take": "last", "pointer": "/id"}}),
    binding("plate_body", {"$select": {"from": {"$ref": "plate_build"}, "path": "/scene/bodies", "where": {"/feature_id": {"$ref": "plate_feature"}}, "take": "one"}}),
    note("Notch in the outline", "A notch or step is a second sketch on the same origin plane, cut through all; its rectangle may overhang the edge."),
    *rectangle("notch", "Notch", 60, 40, 40, 15),
    cut("notch", "Notch"),
    note("Slot", "A slot is sketch_add_slot center_to_center between the two arc centres with the slot width, then the same cut."),
    {"id": "slot_begin", "call": {"group": "sketch/draw", "operation": "sketch_begin", "arguments": {"name": "Slot", "plane": {"type": "origin_plane", "plane": "xy"}}}},
    {"id": "slot_shape", "call": {"group": "sketch/draw", "operation": "sketch_add_slot", "arguments": {"mode": "center_to_center", "p1": {"x": 115, "y": 14}, "p2": {"x": 115, "y": 36}, "cursor": {"x": 118, "y": 25}, "width_mm": 6}}},
    {"id": "slot_finish", "call": {"group": "sketch/draw", "operation": "sketch_finish", "arguments": {}}},
    cut("slot", "Slot"),
    note("Holes from the top face", "Bind the current top face (normal +z and plane origin z = thickness) before each hole step; project the design point (x, y, T) into its basis. One call per callout group with positions."),
    face("slot_cut", "top_0", TOP),
    hole("corner_cbores", "top_0", [(12, 12, T), (148, 12, T)], 6.6, "counterbore", 11, 6.5),
    face("corner_cbores", "top_1", TOP),
    hole("small_cbores", "top_1", [(60, 25, T), (100, 25, T)], 4.5, "counterbore", 8, 4.6),
    face("small_cbores", "top_2", TOP),
    hole("bore", "top_2", [(BORE[0], BORE[1], T)], 20),
    note("Bolt circle", "Four M4 on a 32 mm circle around the bore at 45, 135, 225 and 315 degrees: x = cx + 16 cos(a), y = cy + 16 sin(a)."),
    face("bore", "top_3", TOP),
    hole("bolt_circle_m4", "top_3", [(x, y, T) for x, y in BOLT_CIRCLE], 3.3, extent={"type": "distance", "depth": 9}, thread=M4),
    note("Holes from the bottom face", "A counterbore called out 背面 starts from the bottom face (normal -z, origin z = 0); project the point with z = 0."),
    face("bolt_circle_m4", "bottom_0", BOTTOM),
    hole("back_cbore", "bottom_0", [(130, 38, 0)], 6.6, "counterbore", 11, 4),
    note("Blind hole", "A blind hole uses extent distance with the drilled depth."),
    face("back_cbore", "top_4", TOP),
    hole("blind", "top_4", [(75, 12, T)], 5, extent={"type": "distance", "depth": 5}),
    note("Hole drilled into an edge", "Bind the edge face by its normal (y = 0 edge here) and project a point on that face at mid-thickness: [x, 0, T/2]. The drill goes into the material by default."),
    face("blind", "edge_y0", EDGE_Y0),
    hole("edge_m6", "edge_y0", [(20, 0, T / 2)], 5, extent={"type": "distance", "depth": 13}, thread=M6),
    {"view": "isometric", "fit": True, "body_id": {"$ref": "plate_body", "pointer": "/id"}, "duration_ms": 350},
]
script = {
    "version": 1, "name": "Example plate with every idiom", "starting_state": "empty", "steps": steps,
    "checks": [
        {"id": "final_scene", "call": {"group": "solid/check", "operation": "solid_scene", "arguments": {}}},
        {"assert": {"$ref": "final_scene", "pointer": "/errors"}, "equals": []},
        {"assert": {"$count": {"$ref": "final_scene", "pointer": "/bodies"}}, "equals": 1},
    ],
}
header = (
    "// Example flow for a flat plate part: located outline, one extrusion, a notch cut, a slot,\n"
    "// counterbored holes from the top and the bottom face, a bore with a tapped bolt circle,\n"
    "// a blind hole and a tapped hole drilled into an edge. Millimetres. Origin: lower-left corner\n"
    "// of the plan view, y up, z = thickness.\n"
)
source = header + json.dumps(script, indent=2, ensure_ascii=False) + "\n"
out = ROOT / "skill" / "plate-example.nbcad.jsonc"
out.write_text(source)
print("written", out, len(source), "chars")

if "--validate" in sys.argv:
    step = ROOT / "tools" / "example-validate.step"
    result = subprocess.run([sys.executable, str(ROOT / "python" / "run_script.py"), "--json", str(out), str(step)], capture_output=True, text=True)
    value = json.loads(result.stdout.strip().splitlines()[-1])
    if not value.get("ok"):
        print("VALIDATION FAILED:", value.get("error"))
        sys.exit(1)
    print("steps:", value["steps_completed"], "checks:", value["checks_completed"], "| scene:", json.dumps(value["scene"]))
    print("holes:", json.dumps(value["holes"]["holes"]))
    print("export:", value["export"])
