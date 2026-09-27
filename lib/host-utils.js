/**
 * Platform helpers of the host half, kept free of dsh imports so they can be tested alone.
 */
import { accessSync, chmodSync, constants as fsConstants, statSync } from 'node:fs'
import { basename, delimiter, extname, isAbsolute, join, relative, resolve } from 'node:path'

export const WINDOWS = process.platform === 'win32'
/** Which packed probe binary this machine gets: darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64. */
export const PLATFORM = `${process.platform}-${process.arch}`
export const PROBE_NAME = WINDOWS ? 'print-probe.exe' : 'print-probe'

/** Packed builds to try for this machine, best first: Windows on ARM runs the x64 build under emulation. */
export function platformCandidates(platform = PLATFORM) {
  const fallbacks = { 'win32-arm64': ['win32-x64'], 'darwin-x64': ['darwin-arm64'] }
  return [platform, ...(fallbacks[platform] ?? [])]
}

export function resolvePath(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

export function isFile(path) {
  try { return statSync(path).isFile() } catch { return false }
}

/**
 * Find an executable: a path (absolute or relative, either slash) as is, a bare name on PATH;
 * Windows also tries the PATHEXT extensions, so `nbcad-mcp` finds `nbcad-mcp.exe`.
 * Point config.server at the .exe itself: a .cmd or .bat wrapper cannot be spawned directly.
 */
export function findExecutable(name, env = process.env, windows = WINDOWS) {
  if (!name) return null
  const explicit = /[\\/]/.test(name)
  const extensions = windows && !extname(name) ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()).concat(['']) : ['']
  const dirs = explicit ? [null] : (env.PATH || '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = dir === null ? resolvePath(name) + ext : join(dir, name + ext)
      if (!isFile(candidate)) continue
      if (!windows) { try { accessSync(candidate, fsConstants.X_OK) } catch { continue } }
      return candidate
    }
  }
  return null
}

/** A binary that came through a tarball may have lost its mode bit; restore it once (no-op on Windows). */
export function ensureExecutable(path) {
  if (WINDOWS) return
  try { accessSync(path, fsConstants.X_OK) } catch { try { chmodSync(path, 0o755) } catch {} }
}

/** Is `file` inside `dir` (same path or below), on either separator convention? */
export function insideDir(dir, file) {
  const rel = relative(resolve(dir), resolve(file))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** A file name safe to create under the workspace: letters and digits of any script, dots, dashes, spaces. */
export function safeName(name) {
  const base = basename(String(name || '')).replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/^\.+/, '')
  if (!base) throw new Error('empty file name')
  return base
}

/** Content-Disposition for a download, with the UTF-8 form for names outside ASCII. */
export function attachmentDisposition(fileName) {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

// ----------------------------------------------------------------------------- engine discovery
//
// noBS CAD serves stdio MCP from its own executable: a normal launch opens the window, and
// `--headless` starts an independent worker (docs/INSTALL.md "Connect an MCP agent"). The
// developer build `nbcad-mcp` is headless by itself. The plugin therefore accepts either.

import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'

/** True for the developer executable, which needs no flag. */
export function isDeveloperEngine(path) {
  return /^nbcad-mcp(\.exe)?$/i.test(String(path || '').split(/[\\/]/).pop())
}

/** Arguments the engine needs: none for nbcad-mcp, --headless for the application itself. */
export function engineArgs(path, configured) {
  if (Array.isArray(configured) && configured.length) return configured
  return isDeveloperEngine(path) ? [] : ['--headless']
}

/** The session registry the desktop writes (docs/mcp-harness.md); the same temp dir on every platform. */
export function sessionRegistryDir(env = process.env) {
  return env.NBCAD_SESSION_DIR || join(tmpdir(), 'nbcad-sessions')
}

/** Pids of desktops that refreshed their process record within `freshMs`. */
export function runningDesktopPids(registry = sessionRegistryDir(), freshMs = 60_000, now = Date.now()) {
  const dir = join(registry, '_ui', 'processes')
  const pids = []
  let names = []
  try { names = readdirSync(dir) } catch { return pids }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const record = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      if (Number.isInteger(record.pid) && now - Number(record.updated_ms || 0) <= freshMs) pids.push(record.pid)
    } catch {}
  }
  return pids
}

/** The executable behind a pid, or null: ps on macOS, /proc on Linux, PowerShell on Windows. */
export function executableOfPid(pid, platform = process.platform) {
  try {
    if (platform === 'win32') {
      const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).Path`], { encoding: 'utf8', timeout: 8000, windowsHide: true })
      const path = (run.stdout || '').trim()
      return path && isFile(path) ? path : null
    }
    if (platform === 'linux') {
      const run = spawnSync('readlink', ['-f', `/proc/${pid}/exe`], { encoding: 'utf8', timeout: 3000 })
      const path = (run.stdout || '').trim()
      return path && isFile(path) ? path : null
    }
    const run = spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 })
    const path = (run.stdout || '').trim()
    return path && isAbsolute(path) && isFile(path) ? path : null
  } catch { return null }
}

/** Parse the default value of the nbcad URI handler key: "C:\...\noBS-CAD.exe" "%1". */
export function parseRegistryCommand(text) {
  const m = /"([^"]+\.exe)"/i.exec(text || '') || /^\s*(\S+\.exe)/im.exec(text || '')
  return m ? m[1] : null
}

/** Where the desktop registers itself on Windows after a normal launch (the nbcad:// handler). */
export function windowsRegisteredEngine() {
  try {
    const run = spawnSync('reg.exe', ['query', 'HKCU\\Software\\Classes\\nbcad\\shell\\open\\command', '/ve'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    const path = parseRegistryCommand(run.stdout)
    return path && isFile(path) ? path : null
  } catch { return null }
}

/** Conventional install locations of the application on each platform. */
export function installedEngineCandidates(platform = process.platform, home = homedir()) {
  if (platform === 'darwin') return ['/Applications/noBS CAD.app/Contents/MacOS/nbcad', join(home, 'Applications', 'noBS CAD.app', 'Contents', 'MacOS', 'nbcad')]
  if (platform === 'linux') return ['/usr/bin/nbcad', '/usr/local/bin/nbcad', join(home, '.local', 'bin', 'nbcad'), '/opt/nobs-cad/nbcad']
  return []
}

/**
 * Find the engine. Order: config.server or NBCAD_MCP; nbcad-mcp, nbcad or noBS-CAD on the
 * PATH; the executable of a running noBS CAD desktop; the installed application.
 * @returns {{path: string|null, args: string[], source: string|null, configured: string}}
 */
export function discoverEngine(config = {}, env = process.env, platform = process.platform) {
  const configured = config.server || env.NBCAD_MCP || ''
  const found = (path, source) => ({ path, args: engineArgs(path, config.serverArgs), source, configured: configured || 'auto' })
  if (configured) {
    const path = findExecutable(configured, env, platform === 'win32')
    return path ? found(path, config.server ? 'config' : 'env') : { path: null, args: [], source: null, configured }
  }
  for (const name of ['nbcad-mcp', 'nbcad', 'noBS-CAD']) {
    const path = findExecutable(name, env, platform === 'win32')
    if (path) return found(path, 'path')
  }
  for (const pid of runningDesktopPids(sessionRegistryDir(env))) {
    const path = executableOfPid(pid, platform)
    if (path) return found(path, 'running desktop')
  }
  if (platform === 'win32') {
    const path = windowsRegisteredEngine()
    if (path) return found(path, 'installed app')
  }
  for (const path of installedEngineCandidates(platform)) {
    if (isFile(path)) return found(path, 'installed app')
  }
  return { path: null, args: [], source: null, configured: 'auto' }
}
