"""Shared headless noBS CAD session helpers for the tools in this directory."""
import base64
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mcp_client import McpClient  # noqa: E402

SERVER = os.environ.get("NBCAD_MCP", "nbcad-mcp")  # the headless noBS CAD MCP executable; a bare name is looked up on PATH


def session(log_path):
    return McpClient(SERVER, log_path=str(log_path))


def scene_summary(client):
    scene = client.call("solid_scene")
    bodies = scene.get("bodies", [])
    out = {"bodies": len(bodies), "errors": scene.get("errors", []), "body_details": []}
    for body in bodies:
        faces = body.get("faces", [])
        planar = sum(1 for f in faces if f.get("plane"))
        mesh = body.get("mesh") or {}
        verts = mesh.get("positions") or mesh.get("vertices")
        bbox = None
        if verts:
            flat = verts if isinstance(verts[0], (int, float)) else [c for v in verts for c in v]
            xs, ys, zs = flat[0::3], flat[1::3], flat[2::3]
            bbox = [round(max(xs) - min(xs), 3), round(max(ys) - min(ys), 3), round(max(zs) - min(zs), 3)]
        out["body_details"].append({"id": body.get("id"), "faces": len(faces), "planar_faces": planar, "cylindrical_faces": sum(1 for f in faces if f.get("cylinder")), "bbox": bbox})
    return out


def holes_from_scene(client):
    """Vertical holes as (x, y from the body's bounding-box minimum, diameter, counterbore)."""
    scene = client.call("solid_scene")
    compare = client.call("cad_compare_solids")
    body = (compare.get("bodies") or [{}])[0]
    mn = body.get("bbox_min", [0, 0, 0])
    groups = []
    for b in scene.get("bodies", []):
        for f in b.get("faces", []):
            c = f.get("cylinder")
            if not c:
                continue
            axis, origin, r = c.get("axis") or {}, c.get("origin") or {}, c.get("radius")
            if abs(axis.get("z", 0)) < 0.9 or r is None:
                continue
            x, y = origin["x"], origin["y"]
            for g in groups:
                if abs(g["x"] - x) < 0.3 and abs(g["y"] - y) < 0.3:
                    g["radii"].append(r)
                    break
            else:
                groups.append({"x": x, "y": y, "radii": [r]})
    holes = []
    for g in sorted(groups, key=lambda g: (g["y"], g["x"])):
        rad = sorted(g["radii"])
        holes.append({"x": round(g["x"] - mn[0], 2), "y": round(g["y"] - mn[1], 2), "diameter": round(2 * rad[0], 2), "counterbore": round(2 * rad[-1], 2) if len(rad) > 1 else None})
    return {"bbox_min": mn, "bbox_max": body.get("bbox_max"), "holes": holes}


def export_step(client, path):
    data = base64.b64decode(client.call("solid_export_step", {})["bytes_base64"])
    Path(path).write_bytes(data)
    return {"path": str(path), "bytes": len(data), "is_step": data[:9] == b"ISO-10303"}
