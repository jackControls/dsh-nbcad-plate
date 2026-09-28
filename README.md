# dsh-noBS-CAD-step

npm package `dsh-nobs-cad-step`, plugin id `nobs-cad-step`. Renamed on 2026-09-28
from `dsh-nbcad-plate` (plugin id `nbcad-plate`): remove the old package from a
profile before adding this one, and rename the `id` in any config override.

A [DeepSeek Harness](https://github.com/deepseek-ai/dsh) (`dsh`) plugin that turns
2D engineering prints of flat plate parts into [noBS CAD](https://github.com/jackControls/noBS-CAD)
scripts and STEP files.

It registers:

- the skill `nobs-cad-step`: the standard workflow for plate parts, from a
  ten-hole bracket to a dense plate with eighty holes (sheet survey, callout
  inventory, corner-origin frame, chain arithmetic, one script per part,
  verification by hole counts, report), with two validated example scripts:
  `skill/plate-example.nbcad.jsonc` locates holes by coordinates and shows
  every modelling idiom, `skill/plate-example-chains.nbcad.jsonc` builds the
  same plate with construction chains (lines of the printed lengths from the
  plate edges, holes anchored to their ends) so the engine does the arithmetic
  and a reviewer can compare the chains with the print;
- five tools that drive a headless noBS CAD engine and the print:
  - `nbcad_run_script(script_path, step_path)`: run a version 1 `.nbcad.jsonc`
    script in a blank document, export STEP, return the engine's feature
    summary and warnings (a position left out of `positions`, overlapping
    holes, holes off the body, blind depths deeper than the body, unused
    bindings), the holes found, or the failing step and reason;
  - `nbcad_inspect_step(step_path)`: re-import a STEP file and return the same
    summary, for verification;
  - `nbcad_check(step_path, expected, tolerance_mm?)`: compare the model's
    feature table with the STEP through the engine: matched, missing and extra
    holes with offsets, and the bounding box;
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

What the routes accept: every request must carry a secret that is new on each
boot; dsh writes it into the page and the panel sends it back, so other pages in
the browser and other processes on the machine get `401`. The workspace named
in a request must be one registered in dsh; nothing outside a registered
workspace is listed, read or written. dsh's web server binds to `127.0.0.1`
unless configured otherwise, and the routes still assume a local, single-user
machine.

## Requirements

- `dsh` 0.1.5 to 0.1.9, alphas and release candidates included (the peer ranges
  name each prerelease line explicitly, as node-semver requires), with a profile
  based on `headless`, `tui` or `web`; Node 22 or later.
- noBS CAD. The application itself serves stdio MCP: the plugin starts it with
  `--headless`, so an installed noBS CAD (the release zip on Windows, the app on
  macOS, the deb on Linux) is the engine. A developer build of `nbcad-mcp`
  (`cargo build --manifest-path mcp-server/Cargo.toml` in the noBS CAD checkout)
  works too and needs no flag.

Nothing else: no Python, no poppler, no Rust toolchain. The print probe is packed
as a binary under `bin/` for macOS (Apple silicon and Intel), Linux (x64 and
arm64) and Windows (x64), and it renders PDFs and decodes PNG and JPG prints
itself.

`bin/SHA256SUMS` lists the packed probe binaries. A packed binary that is not
listed or does not match is refused (the status strip says why) and the plugin
falls back to `config.probe`, `NBCAD_PRINT_PROBE`, a local `cargo build
--release` under `native/print-probe`, or `print-probe` on the PATH. Builds from
the `probe binaries` workflow carry a GitHub provenance attestation:
`gh attestation verify bin/darwin-arm64/print-probe --repo jackControls/dsh-noBS-CAD-step`.

The engine is checked on every session: its `cad_interface` tool must offer the
`script`, `summary` and `check` actions (noBS CAD 0.2.1 or newer), otherwise the
tools fail with a clear message instead of halfway through a run.

Limits of the readings: `nbcad_run_script`, `nbcad_inspect_step` and
`nbcad_check` take holes from the vertical cylindrical faces reported by the
engine that built the model (centres grouped within 0.3 mm, the smallest radius
is the hole, the largest a counterbore). Chamfered or tapered holes, filleted
hole edges, slots and angled holes are not holes to them, and an engine mistake
looks the same on both sides of a check. The print is the independent check:
`ring-score`, `symbols` and `nbcad_overlay_print` compare the model with the
drawing itself.

## Install

From GitHub into a profile of your own (the plugin is plain JavaScript plus the
packed binary, so no build approval is needed; use `web` instead of `headless` as
the template to get the panel):

```bash
dsh --profile nbcad --from-default-profile headless --dump-config >/dev/null
dsh plugin --profile nbcad add github:jackControls/dsh-noBS-CAD-step
```

Or from a local checkout:

```bash
dsh plugin --profile nbcad add file:/path/to/dsh-nobs-cad-step
```

The engine is found automatically, in this order: `config.server` or `NBCAD_MCP`;
`nbcad-mcp`, `nbcad` or `noBS-CAD` on the PATH; the executable of a noBS CAD that
is running (read from its session registry); the installed application (on
Windows the `nbcad://` handler noBS CAD registers on its first normal launch, on
macOS `/Applications/noBS CAD.app`, on Linux `/usr/bin/nbcad`). The panel's
status strip says which one it uses. To pin it, set it in the profile's
`cordis.patch.yml` (`~/.dsh/profiles/nbcad/cordis.patch.yml`):

```yaml
- id: nobs-cad-step
  config:
    server: /Applications/noBS CAD.app/Contents/MacOS/nbcad   # or .../nbcad-mcp
    # serverArgs: ['--headless']   # the default for the application; none for nbcad-mcp
```

`probe:` (or `NBCAD_PRINT_PROBE`) overrides the packed print-probe binary with one
you built yourself; it is not needed on the packed platforms. Check with
`dsh --profile nbcad --dump-config` that the `nobs-cad-step` entry is mounted.

## Use

From a workspace that contains the print:

```bash
dsh --profile nbcad "Model scratch/PART.pdf as a STEP file. Load the nobs-cad-step skill first."
```

The skill asks for the script, the STEP file, a feature table and a short report
in the workspace. Run one part per task; a dense plate is allowed several script
runs.

## Windows

The plugin runs on Windows without extra tools; the `smoke` workflow exercises the
host code and the packed `print-probe.exe` on `windows-latest` at every push.
The engine on Windows is the noBS CAD release itself: unzip
`noBS-CAD-<version>-windows-x64.zip`, launch `noBS-CAD.exe` once normally (that
registers the `nbcad://` handler the plugin reads), and the plugin finds it and
starts it with `--headless` for each run. To pin it instead, name the `.exe`
itself (a `.cmd` or `.bat` wrapper cannot be spawned), with forward slashes or a
quoted string:

```yaml
- id: nobs-cad-step
  config:
    server: C:/Users/me/noBS-CAD/noBS-CAD.exe
```

A bare name is looked up on the PATH through `PATHEXT`.

The desktop detection reads `%TEMP%\nbcad-sessions\`, where the noBS CAD desktop
publishes its heartbeats on Windows, and the probe caches page renders under
`%TEMP%\print-probe-cache\` (`PRINT_PROBE_CACHE` moves it). Windows on ARM
falls back to the x64 probe under emulation. Print and part names may use any
script (Chinese file names are kept as they are).

## Layout

```
lib/index.js             plugin entry: skill, the five tools, engine and probe discovery
lib/routes.js            the panel's web routes (per-boot secret, registered workspaces only)
lib/cad.js               engine helpers: run a script, export STEP, inspect a STEP, summarise
lib/mcp-client.js        newline JSON-RPC client for nbcad-mcp (plain Node)
lib/client.js            the "2D → 3D" panel (browser half)
bin/<platform>/          packed print-probe binaries (darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64)
native/print-probe/      Rust source of the probe (PDF rendering by hayro, PNG/JPG by image)
skill/SKILL.md           the workflow (also usable as a plain filesystem skill)
skill/plate-example.nbcad.jsonc   validated example with every idiom
tools/make-example.mjs   regenerates (--write) and validates (--validate) the coordinate example
tools/make-chains-example.mjs   the same for the construction-chain example
.github/workflows/probe-binaries.yml   builds the probe for every packed platform
cordis.patch.yml         bundle patch that mounts the plugin
```

The probe is looked up in this order: `config.probe`, `NBCAD_PRINT_PROBE`,
`bin/<platform>/print-probe`, a local `native/print-probe/target/release` build,
then `print-probe` on the PATH.

## Development

```bash
NBCAD_MCP=/path/to/nbcad-mcp node tools/make-example.mjs --validate
NBCAD_MCP=/path/to/nbcad-mcp node tools/make-chains-example.mjs --validate
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
`dsh plugin --profile nbcad update dsh-nobs-cad-step` (or remove and add again;
bump the version first, a re-add of the same version keeps the old copy).
