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
- four tools that drive a headless noBS CAD engine and the print:
  - `nbcad_run_script(script_path, step_path)`: run a version 1 `.nbcad.jsonc`
    script in a blank document, export STEP, return the scene summary and the
    holes found, or the failing step and reason;
  - `nbcad_inspect_step(step_path)`: re-import a STEP file and return the same
    summary, for verification;
  - `nbcad_print_probe(action, pdf_path, length_mm, width_mm, ...)`: the native
    pixel toolkit (Rust, `native/print-probe`): `calibrate`, `crop` with a
    millimetre grid and hole overlay, `ring-score` (what is drawn at or near
    each model hole), `symbols` (circles and dots found in a region, matched
    against the model). Well under a second per call, renders cached;
  - `nbcad_overlay_print(pdf_path, step_path, out_png, length_mm, width_mm, region?, dpi?)`:
    draw the model's holes onto the plan view of the print (whole page, or a
    high-resolution crop of a millimetre window) so every group can be checked
    against the drawn hole symbols.

The model reads the print itself (its own image reads and `pdftoppm` crops),
writes the script, runs it, compares the hole list with its inventory and fixes
what is missing. Everything goes through the ordinary noBS CAD script
interpreter; there is no second modelling path.

## Requirements

- `dsh` 0.1.5 (release candidates included) with a profile based on `headless`, `tui` or `web`; Node 22 or later.
- A noBS CAD checkout with the MCP server built: `cargo build -p nbcad-mcp`
  (the executable is `target/debug/nbcad-mcp`).
- Python 3 (standard library only) and `pdftoppm` (poppler) on the PATH.

## Install

From GitHub into a profile of your own (the plugin is plain JavaScript and Python, so
no build approval is needed):

```bash
dsh --profile nbcad --from-default-profile headless --dump-config >/dev/null
dsh plugin --profile nbcad add github:jackControls/dsh-nbcad-plate
```

Or from a local checkout:

```bash
dsh plugin --profile nbcad add file:/path/to/dsh-nbcad-plate
```

The native print probe behind `nbcad_print_probe` is optional; build it once with a
Rust toolchain and point the plugin at it (below). Without it the other three tools
still work and `nbcad_overlay_print` uses its Python renderer.

```bash
cargo build --release --manifest-path native/print-probe/Cargo.toml
```

Then point the plugin at the engine in the profile's `cordis.patch.yml`
(`~/.dsh/profiles/nbcad/cordis.patch.yml`):

```yaml
- id: nbcad-plate
  config:
    server: /path/to/noBS-CAD/target/debug/nbcad-mcp
    probe: /path/to/dsh-nbcad-plate/native/print-probe/target/release/print-probe
```

`probe` is needed because the profile holds a copy of the package without the
build directory; `NBCAD_PRINT_PROBE` in the environment works as well.

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
lib/index.js             plugin entry: registers the skill and the four tools
python/run_script.py     run a script through nbcad-mcp and export STEP (--json)
python/inspect_step.py   re-import a STEP file and summarise it (--json)
python/overlay_print.py  draw a model's holes on the print for a visual check (--json)
python/cad.py            engine session helpers (scene summary, hole extraction)
python/mcp_client.py     minimal newline JSON-RPC client for nbcad-mcp
skill/SKILL.md           the workflow (also usable as a plain filesystem skill)
skill/plate-example.nbcad.jsonc   validated example with every idiom
tools/make_example.py    regenerates and validates the example
native/print-probe/      Rust pixel toolkit behind nbcad_print_probe
cordis.patch.yml         bundle patch that mounts the plugin
```

## Development

```bash
NBCAD_MCP=/path/to/nbcad-mcp python3 tools/make_example.py --validate
```

After editing the plugin, refresh the installed copy with
`dsh plugin --profile nbcad update dsh-nbcad-plate` (or remove and add again).
