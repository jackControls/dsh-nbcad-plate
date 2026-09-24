# dsh-nbcad-plate

A [DeepSeek Harness](https://github.com/deepseek-ai/dsh) (`dsh`) plugin that turns
2D engineering prints of flat plate parts into [noBS CAD](https://github.com/jackControls/noBS-CAD)
scripts and STEP files.

It registers:

- the skill `nbcad-plate`: the standard workflow for plate parts, from a
  ten-hole bracket to a dense plate with eighty holes (sheet survey, callout
  inventory, corner-origin frame, chain arithmetic, one script per part,
  verification by hole counts, report), with a validated example script that
  shows every modelling idiom (`skill/plate-example.nbcad.jsonc`);
- two tools that drive a headless noBS CAD engine:
  - `nbcad_run_script(script_path, step_path)`: run a version 1 `.nbcad.jsonc`
    script in a blank document, export STEP, return the scene summary and the
    holes found, or the failing step and reason;
  - `nbcad_inspect_step(step_path)`: re-import a STEP file and return the same
    summary, for verification.

The model reads the print itself (its own image reads and `pdftoppm` crops),
writes the script, runs it, compares the hole list with its inventory and fixes
what is missing. Everything goes through the ordinary noBS CAD script
interpreter; there is no second modelling path.

## Requirements

- `dsh` 0.1.5 or later with a profile based on `headless`, `tui` or `web`.
- A noBS CAD checkout with the MCP server built: `cargo build -p nbcad-mcp`
  (the executable is `target/debug/nbcad-mcp`).
- Python 3 (standard library only) and `pdftoppm` (poppler) on the PATH.

## Install

```bash
dsh --profile nbcad --from-default-profile headless --dump-config >/dev/null
dsh plugin --profile nbcad add file:/path/to/dsh-nbcad-plate
```

Then point the plugin at the engine in the profile's `cordis.patch.yml`
(`~/.dsh/profiles/nbcad/cordis.patch.yml`):

```yaml
- id: nbcad-plate
  config:
    server: /path/to/noBS-CAD/target/debug/nbcad-mcp
```

`NBCAD_MCP` in the environment works as well. Check with
`dsh --profile nbcad --dump-config` that the `nbcad-plate` entry is mounted.

## Use

From a workspace that contains the print:

```bash
dsh --profile nbcad "Model scratch/PART.pdf as a STEP file. Load the nbcad-plate skill first."
```

The skill asks for the script, the STEP file, a feature table and a short report
in the workspace. Run one part per task; a dense plate is allowed several script
runs.

## Layout

```
lib/index.js             plugin entry: registers the skill and the two tools
python/run_script.py     run a script through nbcad-mcp and export STEP (--json)
python/inspect_step.py   re-import a STEP file and summarise it (--json)
python/cad.py            engine session helpers (scene summary, hole extraction)
python/mcp_client.py     minimal newline JSON-RPC client for nbcad-mcp
skill/SKILL.md           the workflow (also usable as a plain filesystem skill)
skill/plate-example.nbcad.jsonc   validated example with every idiom
tools/make_example.py    regenerates and validates the example
cordis.patch.yml         bundle patch that mounts the plugin
```

## Development

```bash
NBCAD_MCP=/path/to/nbcad-mcp python3 tools/make_example.py --validate
```

After editing the plugin, refresh the installed copy with
`dsh plugin --profile nbcad update dsh-nbcad-plate` (or remove and add again).
