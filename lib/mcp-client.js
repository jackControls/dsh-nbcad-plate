/**
 * Minimal MCP stdio client for the headless noBS CAD server (nbcad-mcp).
 * Plain Node: one JSON-RPC message per line, no third-party dependencies.
 */
import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { createInterface } from 'node:readline'

export class McpError extends Error {}

export class McpClient {
  /**
   * @param {string} serverPath executable of the MCP server
   * @param {{args?: string[], logPath?: string|null, initTimeoutMs?: number}} [options]
   */
  constructor(serverPath, { args = [], logPath = null, initTimeoutMs = 180_000 } = {}) {
    this.serverPath = serverPath
    this.pending = new Map()
    this.nextId = 1
    this.calls = 0
    this.exit = null
    this.logFd = logPath ? openSync(logPath, 'a') : null
    this.child = spawn(serverPath, args, { stdio: ['pipe', 'pipe', this.logFd ?? 'ignore'], windowsHide: true })
    this.child.on('error', (error) => this.abandon(new McpError(`cannot start ${serverPath}: ${error.message}`)))
    this.child.on('exit', (code, signal) => {
      this.exit = { code, signal }
      this.abandon(new McpError(`server exited with ${code ?? signal}`))
    })
    this.reader = createInterface({ input: this.child.stdout })
    this.reader.on('line', (line) => {
      const text = line.trim()
      if (!text) return
      let message
      try { message = JSON.parse(text) } catch { return }
      if (!message || typeof message !== 'object' || !('id' in message)) return
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      this.pending.delete(message.id)
      waiter(message)
    })
    this.ready = this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-nbcad-plate', version: '1' } }, initTimeoutMs)
      .then(() => this.notify('notifications/initialized'))
  }

  abandon(error) {
    for (const [id, waiter] of this.pending) {
      this.pending.delete(id)
      waiter({ id, error: { message: error.message, abandoned: true } })
    }
  }

  send(payload) {
    if (this.exit) throw new McpError(`server exited with ${this.exit.code ?? this.exit.signal}`)
    this.child.stdin.write(JSON.stringify(payload) + '\n')
  }

  notify(method, params) {
    const payload = { jsonrpc: '2.0', method }
    if (params !== undefined) payload.params = params
    this.send(payload)
  }

  rpc(method, params, timeoutMs = 900_000) {
    const id = this.nextId++
    return new Promise((resolveReply, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new McpError(`${method}: no reply within ${Math.round(timeoutMs / 1000)} s`))
      }, timeoutMs)
      this.pending.set(id, (reply) => {
        clearTimeout(timer)
        if (reply.error) reject(new McpError(`${method}: ${reply.error.abandoned ? reply.error.message : JSON.stringify(reply.error)}`))
        else resolveReply(reply.result ?? {})
      })
      try { this.send({ jsonrpc: '2.0', id, method, params }) } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }

  async listTools() {
    return (await this.rpc('tools/list', {})).tools ?? []
  }

  /** tools/call decoded the way the noBS CAD replay client decodes it: JSON text content, `status: failed` is an error. */
  async call(name, args = {}, timeoutMs = 900_000) {
    this.calls += 1
    const result = await this.rpc('tools/call', { name, arguments: args }, timeoutMs)
    const content = Array.isArray(result.content) ? result.content : []
    const text = content.find((item) => item && item.type === 'text')?.text
    if (result.isError) throw new McpError(text ?? JSON.stringify(content))
    if (text === undefined) throw new McpError(`${name}: response has no text content`)
    let decoded
    try { decoded = JSON.parse(text) } catch { return text }
    if (decoded && typeof decoded === 'object' && decoded.status === 'failed') throw new McpError(JSON.stringify(decoded))
    return decoded
  }

  interface(action, args = {}) {
    return this.call('cad_interface', { action, ...args })
  }

  /** End the session: close stdin, give the server a moment to exit, then kill it. */
  async close(timeoutMs = 15_000) {
    try { this.child.stdin.end() } catch {}
    if (!this.exit) {
      await new Promise((done) => {
        const timer = setTimeout(() => { try { this.child.kill('SIGKILL') } catch {} }, timeoutMs)
        this.child.once('exit', () => { clearTimeout(timer); done() })
        if (this.exit) { clearTimeout(timer); done() }
      })
    }
    this.reader.close()
    if (this.logFd !== null) { try { closeSync(this.logFd) } catch {} ; this.logFd = null }
  }
}
