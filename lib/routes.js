/**
 * The panel's HTTP routes on dsh's own web server, kept free of dsh imports so
 * they can be tested alone (test/smoke.mjs runs them on a plain node:http server).
 *
 * Two guards apply to every request:
 * - a per-boot secret: the host writes it into the page as a global (an index
 *   injection row) and the panel sends it back in a header. Any other page in
 *   the browser and any process that can reach dsh's port get 401.
 * - `dir` must be a workspace dsh has registered: nothing outside one is
 *   listed, read or written.
 */
import { timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { attachmentDisposition, insideDir, isFile, safeName } from './host-utils.js'

export const ROUTE_PREFIX = '/dsh-nbcad/api'
/** The request header carrying the per-boot secret and the page global the host writes it into. */
export const PANEL_TOKEN_HEADER = 'x-nbcad-panel-token'
export const PANEL_TOKEN_GLOBAL = '__nbcadPanelToken'
const PRINT_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg'])
const DOWNLOAD_EXTENSIONS = new Set(['.step', '.stp', '.md', '.jsonc', '.png', '.pdf'])
export const MAX_PRINT_BYTES = 64 * 1024 * 1024

export function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
  res.end(body)
}

function readBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error(`body larger than ${limit} bytes`)); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Constant-time comparison of the header the browser sent with this boot's secret. */
function tokenMatches(header, token) {
  if (typeof header !== 'string' || typeof token !== 'string' || token.length === 0 || header.length !== token.length) return false
  return timingSafeEqual(Buffer.from(header), Buffer.from(token))
}

/** A workspace directory the browser named: one dsh has registered, and a directory. */
export function workspaceDir(value, registered) {
  if (!value || !isAbsolute(value)) throw new Error('dir must be an absolute workspace path')
  const dir = resolve(value)
  if (!registered().some((path) => resolve(path) === dir)) throw new Error(`not a workspace registered in dsh: ${dir}`)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`not a directory: ${dir}`)
  return dir
}

/** Store one print (PDF, PNG or JPG) under <workspace>/prints/; the probe reads all three directly. */
function storePrint(dir, name, bytes) {
  const file = join(dir, 'prints', safeName(name))
  if (!PRINT_EXTENSIONS.has(extname(file).toLowerCase())) throw new Error('the print must be a .pdf, .png or .jpg file')
  mkdirSync(dirname(file), { recursive: true })
  if (bytes !== null) writeFileSync(file, bytes)
  return file
}

function listOutputs(dir) {
  const files = []
  for (const sub of ['out', '.']) {
    const folder = join(dir, sub)
    let names = []
    try { names = readdirSync(folder) } catch { continue }
    for (const name of names) {
      const ext = extname(name).toLowerCase()
      if (!['.step', '.stp', '.md', '.jsonc'].includes(ext)) continue
      const file = join(folder, name)
      try {
        const stat = statSync(file)
        if (stat.isFile()) files.push({ name, path: file, relative: sub === '.' ? name : `${sub}/${name}`, size: stat.size, modifiedAt: Math.round(stat.mtimeMs), kind: ext === '.step' || ext === '.stp' ? 'step' : ext === '.md' ? 'report' : 'script' })
      } catch {}
    }
  }
  files.sort((a, b) => b.modifiedAt - a.modifiedAt)
  return files
}

/**
 * The route handler.
 * @param {object} deps
 * @param {string} deps.token the per-boot secret the panel must send back
 * @param {() => string[]} deps.workspaces paths of the workspaces registered in dsh
 * @param {() => object} deps.status the status report
 * @param {number} [deps.maxPrintBytes]
 */
export function createRouteHandler({ token, workspaces, status, maxPrintBytes = MAX_PRINT_BYTES }) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const route = url.pathname.slice(ROUTE_PREFIX.length)
    if (!tokenMatches(req.headers[PANEL_TOKEN_HEADER], token)) {
      return sendJson(res, 401, { ok: false, error: 'unauthorized: these routes serve the 2D → 3D panel of this dsh page only; reload the page if the panel shows this' })
    }
    try {
      if (route === '/status' && req.method === 'GET') return sendJson(res, 200, status())
      if (route === '/print' && req.method === 'POST') {
        const dir = workspaceDir(url.searchParams.get('dir'), workspaces)
        const body = await readBody(req, maxPrintBytes)
        if (body.length === 0) throw new Error('empty file')
        const file = storePrint(dir, url.searchParams.get('name'), body)
        return sendJson(res, 200, { ok: true, path: file, bytes: body.length })
      }
      if (route === '/local-print' && req.method === 'POST') {
        // a print that already exists on this machine: copy it into the workspace
        const dir = workspaceDir(url.searchParams.get('dir'), workspaces)
        const source = String(url.searchParams.get('path') || '')
        if (!isAbsolute(source) || !isFile(source)) throw new Error('path must be an existing file on this machine')
        const target = storePrint(dir, basename(source), null)
        if (resolve(source) !== target) writeFileSync(target, readFileSync(source))
        return sendJson(res, 200, { ok: true, path: target, bytes: statSync(target).size })
      }
      if (route === '/outputs' && req.method === 'GET') {
        const dir = workspaceDir(url.searchParams.get('dir'), workspaces)
        return sendJson(res, 200, { ok: true, dir, files: listOutputs(dir) })
      }
      if (route === '/file' && req.method === 'GET') {
        const dir = workspaceDir(url.searchParams.get('dir'), workspaces)
        const file = resolve(String(url.searchParams.get('path') || ''))
        if (!insideDir(dir, file) || !DOWNLOAD_EXTENSIONS.has(extname(file).toLowerCase()) || !isFile(file)) throw new Error('file must be a STEP, report or script inside the workspace')
        const stat = statSync(file)
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': stat.size, 'content-disposition': attachmentDisposition(basename(file)), 'cache-control': 'no-store' })
        createReadStream(file).pipe(res)
        return
      }
      sendJson(res, 404, { ok: false, error: `unknown route ${route}` })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message || error) })
    }
  }
}
