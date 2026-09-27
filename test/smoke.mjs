// Platform smoke test: run on macOS, Linux and Windows without dsh or a noBS CAD build.
//   node test/smoke.mjs
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkStep, inspectStep, runScript } from '../lib/cad.js'
import { PLATFORM, PROBE_NAME, WINDOWS, discoverEngine, engineArgs, executableOfPid, findExecutable, insideDir, parseRegistryCommand, platformCandidates, runningDesktopPids, safeName } from '../lib/host-utils.js'
import { spawn } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = mkdtempSync(join(tmpdir(), 'nbcad-smoke-'))
let failures = 0
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`); if (!ok) failures += 1 }

// 1. executables: bare names resolve through PATHEXT on Windows, explicit paths on either slash
const stubName = WINDOWS ? 'nbcad-mcp.cmd' : 'nbcad-mcp'
writeFileSync(join(tmp, stubName), WINDOWS ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 })
const found = findExecutable('nbcad-mcp', { PATH: tmp, PATHEXT: '.EXE;.CMD;.BAT' }, WINDOWS)
check('bare engine name found on PATH', found === join(tmp, stubName), String(found))
check('explicit path found', findExecutable(join(tmp, stubName)) === join(tmp, stubName))
check('missing name is null', findExecutable('no-such-engine-xyz', { PATH: tmp }) === null)

// 2. workspace containment and file names
const ws = join(tmp, 'ws')
check('inside: file below the workspace', insideDir(ws, join(ws, 'out', 'part.step')))
check('inside: the workspace itself', insideDir(ws, ws))
check('outside: sibling with a common prefix', !insideDir(ws, join(tmp, 'wsx', 'part.step')))
check('outside: parent traversal', !insideDir(ws, join(ws, '..', 'other.step')))
check('safeName keeps Chinese names', safeName('图纸-01.pdf') === '图纸-01.pdf')
check('safeName strips directories', safeName('../../etc/passwd') === 'passwd')
check('platform candidates', platformCandidates('win32-arm64').includes('win32-x64'))

// 2b. engine discovery: the application on the PATH gets --headless, nbcad-mcp does not, a running
// desktop is found through its process record, the Windows registry value parses
check('nbcad-mcp needs no flag', engineArgs('/x/nbcad-mcp').length === 0 && engineArgs('C:\\x\\nbcad-mcp.exe').length === 0)
check('the application gets --headless', JSON.stringify(engineArgs('C:\\x\\noBS-CAD.exe')) === '["--headless"]')
check('explicit serverArgs win', JSON.stringify(engineArgs('/x/nbcad', ['--headless', '--desktop'])) === '["--headless","--desktop"]')
check('registry command parses', parseRegistryCommand('    (Default)    REG_SZ    "C:\\Apps\\noBS-CAD\\noBS-CAD.exe" "%1"') === 'C:\\Apps\\noBS-CAD\\noBS-CAD.exe')
const appName = WINDOWS ? 'noBS-CAD.exe' : 'nbcad'
const appDir = join(tmp, 'app-on-path'); mkdirSync(appDir, { recursive: true })
writeFileSync(join(appDir, appName), WINDOWS ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 })
const viaPath = discoverEngine({}, { PATH: appDir, PATHEXT: '.EXE;.CMD;.BAT', NBCAD_SESSION_DIR: join(tmp, 'no-registry') }, process.platform)
check('application found on the PATH with --headless', viaPath.source === 'path' && viaPath.path === join(appDir, appName) && viaPath.args[0] === '--headless', JSON.stringify(viaPath))
const devFirst = discoverEngine({}, { PATH: tmp + (WINDOWS ? ';' : ':') + appDir, PATHEXT: '.EXE;.CMD;.BAT', NBCAD_SESSION_DIR: join(tmp, 'no-registry') }, process.platform)
check('nbcad-mcp on the PATH wins over the application', devFirst.source === 'path' && devFirst.args.length === 0 && /nbcad-mcp/.test(devFirst.path), JSON.stringify(devFirst))
const registry = join(tmp, 'registry'); mkdirSync(join(registry, '_ui', 'processes'), { recursive: true })
const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' })
writeFileSync(join(registry, '_ui', 'processes', 'test.json'), JSON.stringify({ pid: helper.pid, process_instance_id: 'test', updated_ms: Date.now(), windows: [] }))
check('running desktop pid read from the registry', runningDesktopPids(registry).includes(helper.pid))
const exe = executableOfPid(helper.pid)
check('executable of a running pid resolved', exe !== null && existsSync(exe), String(exe))
const viaDesktop = discoverEngine({}, { PATH: join(tmp, 'empty'), NBCAD_SESSION_DIR: registry }, process.platform)
check('running desktop becomes the engine with --headless', viaDesktop.source === 'running desktop' && viaDesktop.path === exe && viaDesktop.args[0] === '--headless', JSON.stringify(viaDesktop))
helper.kill()

// 3. the engine helpers through a stand-in MCP server
const fake = { path: process.execPath, args: [join(ROOT, 'test', 'fake-nbcad-mcp.mjs')] }
const script = join(tmp, 'part.nbcad.jsonc'); writeFileSync(script, '{"version":1,"steps":[]}')
const step = join(tmp, 'part.step')
const run = await runScript(fake, script, step)
check('runScript ok', run.ok === true, run.error)
check('runScript exported a STEP', existsSync(step) && readFileSync(step, 'utf8').startsWith('ISO-10303'))
check('runScript hole list from geometry', run.holes?.holes?.length === 2 && run.holes.holes[0].counterbore === 11, JSON.stringify(run.holes?.holes))
check('runScript passes the engine summary and warnings', run.summary?.hole_count === 2 && Array.isArray(run.warnings))
const anchoredScript = join(tmp, 'anchored.nbcad.jsonc'); writeFileSync(anchoredScript, '{"version":1,"steps":[{"position_reference":{}}]}')
const anchored = await runScript(fake, anchoredScript, join(tmp, 'anchored.step'))
check('anchored scripts drop position-based warnings', anchored.warnings?.length === 1 && anchored.warnings[0].code === 'unused_binding' && typeof anchored.warnings_note === 'string')
const inspect = await inspectStep(fake, step)
check('inspectStep ok', inspect.ok === true && inspect.holes?.holes?.length === 2, inspect.error)
const checked = await checkStep(fake, step, { bbox: [160, 50, 8], holes: [] }, 0.6)
check('checkStep ok', checked.ok === true && checked.check?.holes?.matched?.length === 2, checked.error)
const lossless = JSON.stringify(run); check('results are lossless JSON', JSON.stringify(JSON.parse(lossless)) === lossless)

// 4. the packed probe on a synthetic print: a 200 x 100 plate drawn 1:1 on an A4 landscape sheet
const probe = platformCandidates(PLATFORM).map((p) => join(ROOT, 'bin', p, PROBE_NAME)).find((p) => existsSync(p))
check('packed probe present for ' + PLATFORM, Boolean(probe), probe)
if (probe) {
  const pt = 72 / 25.4 // points per mm
  const [x0, y0, L, W] = [45 * pt, 60 * pt, 200 * pt, 100 * pt] // inside the 297 x 210 mm sheet
  const content = [
    '1.2 w', `${x0} ${y0} ${L} ${W} re S`, // the plate outline, heavy
    '0.35 w', `${x0} ${y0 + W + 8 * pt} m ${x0 + L} ${y0 + W + 8 * pt} l S`, // a dimension line above it, light
    `${x0} ${y0 + W} m ${x0} ${y0 + W + 10 * pt} l S`, `${x0 + L} ${y0 + W} m ${x0 + L} ${y0 + W + 10 * pt} l S`, // its extension lines
    `${x0 - 8 * pt} ${y0} m ${x0 - 8 * pt} ${y0 + W} l S`,
    '0.5 w', `${x0 + 30 * pt - 4 * pt} ${y0 + 20 * pt} m ${x0 + 30 * pt + 4 * pt} ${y0 + 20 * pt} l S`, `${x0 + 30 * pt} ${y0 + 20 * pt - 4 * pt} m ${x0 + 30 * pt} ${y0 + 20 * pt + 4 * pt} l S`, // a hole crosshair
  ].join('\n')
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Contents 4 0 R >>', `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`]
  let pdf = '%PDF-1.4\n'; const offsets = []
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${body}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const print = join(tmp, 'plate.pdf'); writeFileSync(print, pdf)
  const env = { ...process.env, PRINT_PROBE_CACHE: join(tmp, 'cache') }
  const probeJson = (args) => {
    let out
    try { out = execFileSync(probe, args, { env, encoding: 'utf8' }) } catch (error) { out = String(error.stdout || '') } // a probe failure is a JSON line and exit 1
    return JSON.parse(out.trim().split('\n').pop())
  }
  const info = probeJson(['info', '--print', print]); check('probe info', info.ok === true && info.pages === 1, JSON.stringify(info))
  const render = probeJson(['render', '--print', print, '--dpi', '100', '--out', join(tmp, 'page.png')]); check('probe render', render.ok === true && existsSync(join(tmp, 'page.png')), JSON.stringify(render).slice(0, 200))
  const cal = probeJson(['calibrate', '--print', print, '--length', '200', '--width', '100', '--out', join(tmp, 'cal.png')])
  const ppm = cal.calibration?.px_per_mm ?? 0
  check('probe calibrate finds the 1:1 outline', cal.ok === true && Math.abs(ppm - 300 / 25.4) / (300 / 25.4) < 0.03, JSON.stringify(cal).slice(0, 220))
  const crop = probeJson(['crop', '--print', print, '--length', '200', '--width', '100', '--region', '0,0,60,40', '--out', join(tmp, 'crop.png'), '--grid', '10']); check('probe crop', crop.ok === true && existsSync(join(tmp, 'crop.png')), JSON.stringify(crop).slice(0, 160))
  const symbols = probeJson(['symbols', '--print', print, '--length', '200', '--width', '100', '--out', join(tmp, 'symbols.png')]); check('probe symbols with a picture', symbols.ok === true && existsSync(join(tmp, 'symbols.png')), JSON.stringify(symbols).slice(0, 160))
  const missing = probeJson(['info', '--print', join(tmp, 'nope.pdf')]); check('probe reports a missing file as JSON', missing.ok === false && /cannot read/.test(missing.error), JSON.stringify(missing))
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed', 'on', PLATFORM)
process.exit(failures ? 1 : 0)
