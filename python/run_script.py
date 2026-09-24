#!/usr/bin/env python3
"""Run a version 1 .nbcad.jsonc script headlessly in noBS CAD and export STEP.

  run_script.py [--json] <script.nbcad.jsonc> <out.step>
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cad import export_step, holes_from_scene, scene_summary, session  # noqa: E402

args = [a for a in sys.argv[1:] if a != "--json"]
as_json = "--json" in sys.argv
script_path, step_path = Path(args[0]), Path(args[1])
result = {"ok": False, "script": str(script_path), "step": str(step_path)}
client = None
try:
    source = script_path.read_text(encoding="utf-8")
    client = session(step_path.with_suffix(".mcp.log"))
    run = client.call("cad_interface", {"action": "script", "source": source, "mode": "fast"})
    result.update({"ok": True, "steps_completed": run.get("steps_completed"), "checks_completed": run.get("checks_completed"), "elapsed_ms": run.get("elapsed_ms")})
    result["scene"] = scene_summary(client)
    result["holes"] = holes_from_scene(client)
    result["export"] = export_step(client, step_path)
except Exception as error:  # the message names the failing step
    result["error"] = str(error)[:4000]
finally:
    if client is not None:
        client.close()
if as_json:
    print(json.dumps(result))
else:
    if result["ok"]:
        print("script ok:", json.dumps({k: result[k] for k in ("steps_completed", "checks_completed", "elapsed_ms")}))
        print("scene:", json.dumps(result["scene"]))
        print("holes:", json.dumps(result["holes"]))
        print("export:", json.dumps(result["export"]))
    else:
        print("SCRIPT FAILED:", result["error"])
sys.exit(0 if result["ok"] else 1)
