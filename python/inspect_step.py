#!/usr/bin/env python3
"""Re-import a STEP file headlessly and report bounding box, faces and holes.

  inspect_step.py [--json] <file.step>
"""
import base64
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cad import holes_from_scene, scene_summary, session  # noqa: E402

args = [a for a in sys.argv[1:] if a != "--json"]
as_json = "--json" in sys.argv
path = Path(args[0])
result = {"ok": False, "step": str(path)}
client = None
try:
    client = session(path.with_suffix(".inspect.log"))
    groups = {op: g["id"] for g in client.interface("catalog")["groups"] for op in g.get("operations", [])}
    client.interface("execute", group=groups["solid_import_step"], operation="solid_import_step", arguments={"file_name": path.name, "data_base64": base64.b64encode(path.read_bytes()).decode()})
    result.update({"ok": True, "scene": scene_summary(client), "holes": holes_from_scene(client)})
except Exception as error:
    result["error"] = str(error)[:4000]
finally:
    if client is not None:
        client.close()
print(json.dumps(result) if as_json else json.dumps(result, indent=1))
sys.exit(0 if result["ok"] else 1)
