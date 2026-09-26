import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

export type Edition = 'open-source' | 'online'
type Reply = { protocol: 1; edition: Edition; pid: number; status: 'running' | 'yielding' | 'busy' | 'starting' | 'denied' }
type Request = { protocol: 1; edition: Edition; action: 'activate' | 'shutdown' | 'status'; executable?: string }
export type SessionOptions = {
  edition: Edition
  endpoint: string
  executable: string
  state: () => 'ready' | 'busy' | 'starting'
  onActivate: () => void
  onQuit: () => void | boolean | Promise<void | boolean>
  timeoutMs?: number
}
export type SessionResult = { acquired: true; server: net.Server } | { acquired: false; reason: string }

/** The endpoint is shared across editions and profiles in one interactive user session. */
export function editionSessionEndpoint(testNamespace?: string): string {
  let session = process.env.XDG_SESSION_ID || process.env.DISPLAY || 'desktop'
  if (!testNamespace && process.platform === 'win32') {
    session = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Process -Id ' + process.pid + ').SessionId'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim()
    if (!/^\d+$/.test(session)) throw new Error('Cannot identify the interactive session')
  }
  const namespace = testNamespace ? 'test:' + testNamespace : os.homedir().toLowerCase() + '|' + session
  const hash = createHash('sha256').update(namespace).digest('hex').slice(0, 24)
  return process.platform === 'win32' ? '\\\\.\\pipe\\sidekick-editions-' + hash : path.join(os.tmpdir(), 'sidekick-editions-' + hash + '.sock')
}

export function requestEdition(endpoint: string, request: Request, timeoutMs = 1500): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint)
    let received = ''
    const fail = (error: Error) => { socket.destroy(); reject(error) }
    socket.setTimeout(timeoutMs, () => fail(new Error('Edition response timed out')))
    socket.on('error', fail)
    socket.once('connect', () => socket.write(JSON.stringify(request) + '\n'))
    socket.on('data', chunk => {
      received += chunk.toString('utf8')
      if (received.length > 4096) return fail(new Error('Invalid edition response'))
      if (!received.includes('\n')) return
      try {
        const value = JSON.parse(received.split('\n')[0]) as Reply
        if (value.protocol !== 1 || !['open-source', 'online'].includes(value.edition) || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !['running', 'yielding', 'busy', 'starting', 'denied'].includes(value.status)) throw new Error('Unknown edition protocol')
        socket.destroy()
        resolve(value)
      } catch (error) { fail(error as Error) }
    })
    socket.once('end', () => { if (!received.includes('\n')) fail(new Error('Incomplete edition response')) })
  })
}

function listen(options: SessionOptions): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    let quitting = false
    let saveRejected = false
    const server = net.createServer(socket => {
      let received = ''
      socket.setTimeout(1500, () => socket.destroy())
      socket.on('error', () => socket.destroy())
      socket.on('data', chunk => {
        received += chunk.toString('utf8')
        if (received.length > 4096) return socket.destroy()
        if (!received.includes('\n')) return
        socket.removeAllListeners('data')
        let status: Reply['status'] = 'denied'
        let quit = false
        try {
          const request = JSON.parse(received.split('\n')[0]) as Request
          if (request.protocol === 1 && ['open-source', 'online'].includes(request.edition)) {
            const sameEdition = request.edition === options.edition
            const shutdown = request.action === 'shutdown' && options.edition === 'open-source' && sameEdition && typeof request.executable === 'string' && path.resolve(request.executable).toLowerCase() === path.resolve(options.executable).toLowerCase()
            const takeover = request.action === 'activate' && options.edition === 'open-source' && request.edition === 'online'
            if (request.action === 'status') {
              const state = options.state()
              status = saveRejected ? 'busy' : quitting ? 'yielding' : state === 'ready' ? 'running' : state
            } else if (shutdown || takeover) {
              saveRejected = false
              const state = options.state()
              status = quitting ? 'yielding' : state === 'ready' ? 'yielding' : state
              quit = status === 'yielding' && !quitting
              if (quit) quitting = true
            } else if (sameEdition && request.action === 'activate') {
              status = 'running'
              options.onActivate()
            }
          }
        } catch { status = 'denied' }
        socket.end(JSON.stringify({ protocol: 1, edition: options.edition, pid: process.pid, status } satisfies Reply) + '\n', () => {
          if (quit) {
            Promise.resolve().then(() => options.onQuit()).then(accepted => {
              if (accepted === false) { quitting = false; saveRejected = true }
            }).catch(() => { quitting = false; saveRejected = true })
          }
        })
      })
    })
    server.once('error', reject)
    server.listen(options.endpoint, () => {
      server.removeListener('error', reject)
      server.on('error', error => console.error('[EditionSession]', error))
      resolve(server)
    })
  })
}

/** Keep the returned server alive until the owning process has actually exited. */
export async function acquireEditionSession(options: SessionOptions): Promise<SessionResult> {
  const deadline = Date.now() + (options.timeoutMs ?? 30000)
  let requestedQuit = false
  while (Date.now() < deadline) {
    try { return { acquired: true, server: await listen(options) } }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') return { acquired: false, reason: (error as Error).message }
    }
    try {
      const peer = await requestEdition(options.endpoint, { protocol: 1, edition: options.edition, action: requestedQuit ? 'status' : 'activate' })
      if (peer.status === 'yielding') requestedQuit = true
      if (peer.status === 'running') return { acquired: false, reason: '该版本已在运行，已切换到现有窗口。' }
      if (peer.status === 'busy') return { acquired: false, reason: '开源版正在导入、恢复数据，或未能完成保存。请处理后重新启动联网版。' }
      if (peer.status === 'denied') return { acquired: false, reason: '联网版正在运行，请退出联网版后再启动开源版。' }
    } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET'].includes((error as NodeJS.ErrnoException).code ?? '')) return { acquired: false, reason: '无法确认另一版本的运行状态：' + (error as Error).message }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return { acquired: false, reason: '开源版尚未完成保存退出。未强制结束原进程，请检查未保存内容或关闭确认后重试。' }
}
