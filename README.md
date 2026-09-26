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
  - `nbcad_print_probe(action, print_path, ...)`: the native pixel toolkit
    (Rust, `native/print-probe`, packed as a binary for every platform). It
    reads PDF, PNG and JPG prints itself: `render` (a PNG of the page or of a
    window given as page fractions, at any dpi: this is how the model reads the
    sheet), `info`, and with the plate size `calibrate`, `crop` with a
    millimetre grid and hole overlay, `ring-score` (what is drawn at or near
    each model hole), `symbols` (circles and dots found in a region, matched
    against the model). Well under a second per call once a page is rendered;
    renders are cached;
  - `nbcad_overlay_print(print_path, step_path, out_png, length_mm, width_mm, region?, dpi?)`:
    draw the model's holes onto the plan view of the print (whole plate, or a
    high-resolution crop of a millimetre window) so every group can be checked
    against the drawn hole symbols.

The model reads the print itself (through the probe's `render` and `crop`
images), writes the script, runs it, compares the hole list with its inventory
and fixes what is missing. Everything goes through the ordinary noBS CAD script
interpreter; there is no second modelling path.

## The "2D → 3D" panel in the Web UI

In a `web` profile the plugin adds a **2D → 3D** entry to the sidebar's panel list.
The panel:

- shows, refreshed every two seconds, whether the noBS CAD engine (`nbcad-mcp`)
  is reachable, whether a **noBS CAD desktop is running** (read from the desktop's
  session registry: a `heartbeat.json` newer than 30 seconds under
  `<temp dir>/nbcad-sessions/`, the same rule the MCP server uses), and whether
  the print probe binary for this machine is present;
- takes one print (PDF, PNG or JPG), either uploaded from the browser or named by
  its path on the machine that runs dsh; the probe reads all three directly;
- starts a new session in the chosen workspace with the plate-workflow brief,
  names it after the part, and follows it: **Open conversation** switches to it;
- lists every STEP file (and report) the run produces under `<workspace>/out/`
  and saves it where you choose (**Save STEP as…**, the browser's save dialog
  where available, otherwise a download).

The panel is bilingual (English and Chinese) and follows dsh's global language
setting (Settings → General → Language, stored as `locale.preference` in
`settings.yaml`); switching the language re-renders the panel and its sidebar
entry at once. When the UI is in Chinese the brief also asks the model to answer
and write `report.md` in Chinese; the script and the field names stay English.

Nothing here bypasses the model: the panel only prepares the workspace, sends the
brief and collects the files. The host half serves the panel's routes under
`/dsh-nbcad/api` on dsh's own web server; headless profiles do not mount them.

## Requirements

- `dsh` 0.1.5 (release candidates included) with a profile based on `headless`,
  `tui` or `web`; Node 22 or later.
- A noBS CAD build with the MCP server: `cargo build -p nbcad-mcp` in the noBS CAD
  checkout (the executable is `target/debug/nbcad-mcp`, `nbcad-mcp.exe` on Windows).

Nothing else: no Python, no poppler, no Rust toolchain. The print probe is packed
as a binary under `bin/` for macOS (Apple silicon and Intel), Linux (x64 and
arm64) and Windows (x64), and it renders PDFs and decodes PNG and JPG prints
itself.

## Install

From GitHub into a profile of your own (the plugin is plain JavaScript plus the
packed binary, so no build approval is needed; use `web` instead of `headless` as
the template to get the panel):

```bash
dsh --profile nbcad --from-default-profile headless --dump-config >/dev/null
dsh plugin --profile nbcad add github:jackControls/dsh-nbcad-plate
```

Or from a local checkout:

```bash
dsh plugin --profile nbcad add file:/path/to/dsh-nbcad-plate
```

Then point the plugin at the engine in the profile's `cordis.patch.yml`
(`~/.dsh/profiles/nbcad/cordis.patch.yml`):

```yaml
- id: nbcad-plate
  config:
    server: /path/to/noBS-CAD/target/debug/nbcad-mcp
```

`NBCAD_MCP` in the environment works as well, and a bare `nbcad-mcp` is looked up
on the PATH. `probe:` (or `NBCAD_PRINT_PROBE`) overrides the packed print-probe
binary with one you built yourself; it is not needed on the packed platforms.
Check with `dsh --profile nbcad --dump-config` that the `nbcad-plate` entry is
mounted.

## Use

From a workspace that contains the print:

```bash
dsh --profile nbcad "Model scratch/PART.pdf as a STEP file. Load the nbcad-plate skill first."
```

The skill asks for the script, the STEP file, a feature table and a short report
in the workspace. Run one part per task; a dense plate is allowed several script
runs.

## Windows

The plugin runs on Windows without extra tools. Give the engine path with forward
slashes or a quoted string:

```yaml
- id: nbcad-plate
  config:
    server: C:/Users/me/noBS-CAD/target/debug/nbcad-mcp.exe
```

The desktop detection reads `%TEMP%\nbcad-sessions\`, where the noBS CAD desktop
publishes its heartbeats on Windows, and the probe caches page renders under
`%TEMP%\print-probe-cache\` (`PRINT_PROBE_CACHE` moves it).

## Layout

```
lib/index.js             plugin entry: skill, the four tools, the panel's web routes
lib/cad.js               engine helpers: run a script, export STEP, inspect a STEP, summarise
lib/mcp-client.js        newline JSON-RPC client for nbcad-mcp (plain Node)
lib/client.js            the "2D → 3D" panel (browser half)
bin/<platform>/          packed print-probe binaries (darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64)
native/print-probe/      Rust source of the probe (PDF rendering by hayro, PNG/JPG by image)
skill/SKILL.md           the workflow (also usable as a plain filesystem skill)
skill/plate-example.nbcad.jsonc   validated example with every idiom
tools/make-example.mjs   regenerates (--write) and validates (--validate) the example
.github/workflows/probe-binaries.yml   builds the probe for every packed platform
cordis.patch.yml         bundle patch that mounts the plugin
```

The probe is looked up in this order: `config.probe`, `NBCAD_PRINT_PROBE`,
`bin/<platform>/print-probe`, a local `native/print-probe/target/release` build,
then `print-probe` on the PATH.

## Development

```bash
NBCAD_MCP=/path/to/nbcad-mcp node tools/make-example.mjs --validate
```

To rebuild the probe for this machine:

```bash
cargo build --release --manifest-path native/print-probe/Cargo.toml
cp native/print-probe/target/release/print-probe bin/<platform>/
```

The `probe binaries` workflow builds all five packed platforms on GitHub; after a
run, `gh run download <run-id> -D dist` and copy each `dist/print-probe-<platform>`
into `bin/<platform>/`.

After editing the plugin, refresh the installed copy with
`dsh plugin --profile nbcad update dsh-nbcad-plate` (or remove and add again;
bump the version first, a re-add of the same version keeps the old copy).
