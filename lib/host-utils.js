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
