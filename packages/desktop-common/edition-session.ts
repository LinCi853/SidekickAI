import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { product } from '../product-contract'
import { runningApplications, type RunningApplication } from './running-application.js'

export type Edition = 'concept' | 'community'
type Reply = { protocol: 1; edition: Edition; version: string; executable: string; pid: number; retryableHandoff?: boolean; status: 'running' | 'yielding' | 'busy' | 'starting' | 'denied' }
type Request = { protocol: 1; edition: Edition; version?: string; action: 'activate' | 'shutdown' | 'status'; executable?: string }
export type SessionOptions = {
  edition: Edition
  endpoint: string
  executable: string
  version?: string
  legacyApplications?: () => RunningApplication[]
  state: () => 'ready' | 'busy' | 'starting'
  onActivate: () => void
  onQuit: () => void | boolean | Promise<void | boolean>
  timeoutMs?: number
}
export type SessionResult = { acquired: true; server: net.Server } | { acquired: false; reason: string }

/** Editions and portable profiles share one application owner per interactive session. */
export function editionSessionEndpoint(testNamespace?: string, _edition: Edition = 'concept', _profile = ''): string {
  let session = process.env.XDG_SESSION_ID || process.env.DISPLAY || 'desktop'
  if (!testNamespace && process.platform === 'win32') {
    session = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Process -Id ' + process.pid + ').SessionId'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim()
    if (!/^\d+$/.test(session)) throw new Error('Cannot identify the interactive session')
  }
  const namespace = testNamespace ? 'test:' + testNamespace : os.homedir().toLowerCase() + '|' + session
  const hash = createHash('sha256').update(namespace + '|exclusive-application').digest('hex').slice(0, 24)
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
        if (value.protocol !== 1 || !['concept', 'community'].includes(value.edition) || typeof value.version !== 'string' || !value.version || typeof value.executable !== 'string' || !path.isAbsolute(value.executable) || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !['running', 'yielding', 'busy', 'starting', 'denied'].includes(value.status)) throw new Error('Unknown edition protocol')
        socket.destroy()
        resolve(value)
      } catch (error) { fail(error as Error) }
    })
    socket.once('end', () => { if (!received.includes('\n')) fail(new Error('Incomplete edition response')) })
  })
}

function listen(options: SessionOptions): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const version = options.version ?? product.version
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
          if (request.protocol === 1 && ['concept', 'community'].includes(request.edition)) {
            const sameEdition = request.edition === options.edition
            const communityTakeover = options.edition === 'concept' && request.edition === 'community' && request.version === version
            const shutdown = request.action === 'shutdown' && (sameEdition || communityTakeover) && (request.version === undefined || request.version === version) && typeof request.executable === 'string' && path.resolve(request.executable).toLowerCase() === path.resolve(options.executable).toLowerCase()
            if (request.action === 'status') {
              const state = options.state()
              status = saveRejected ? 'busy' : quitting ? 'yielding' : state === 'ready' ? 'running' : state
            } else if (shutdown) {
              saveRejected = false
              const state = options.state()
              status = quitting ? 'yielding' : state === 'ready' ? 'yielding' : state
              quit = status === 'yielding' && !quitting
              if (quit) quitting = true
            } else if (request.action === 'activate' && (request.version === undefined || request.version === version)) {
              status = options.state() === 'starting' ? 'starting' : 'running'
              if (status === 'running') options.onActivate()
            }
          }
        } catch { status = 'denied' }
        socket.end(JSON.stringify({ protocol: 1, edition: options.edition, version, executable: options.executable, pid: process.pid, status, retryableHandoff: saveRejected && options.state() === 'ready' } satisfies Reply) + '\n', () => {
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
  const version = options.version ?? product.version
  let requestedQuit = false
  while (Date.now() < deadline) {
    try {
      const server = await listen(options)
      try {
        const existing = (options.legacyApplications ?? runningApplications)()
        if (existing.length) {
          await new Promise<void>(resolve => server.close(() => resolve()))
          return { acquired: false, reason: `另一个工百窗实例（${existing.map(value => value.version).join('、')}）正在运行，尚未建立可验证的启动协调。请先保存并退出后重试。` }
        }
        return { acquired: true, server }
      } catch (error) {
        await new Promise<void>(resolve => server.close(() => resolve()))
        return { acquired: false, reason: '无法核对已有工百窗进程，请重试：' + (error as Error).message }
      }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') return { acquired: false, reason: (error as Error).message }
    }
    try {
      const request = { protocol: 1 as const, edition: options.edition, version }
      const peer = await requestEdition(options.endpoint, { ...request, action: 'status' })
      if (peer.version !== version) return { acquired: false, reason: `另一个版本（${peer.version}）正在运行，请先保存并退出后再启动 ${version}。` }
      if (peer.edition === 'community' || !requestedQuit && options.edition === 'concept') {
        const activated = await requestEdition(options.endpoint, { ...request, action: 'activate' })
        if (activated.status === 'running') return { acquired: false, reason: '工百窗已在运行，已切换到现有窗口。' }
      } else {
        if (peer.status === 'busy' && (requestedQuit || !peer.retryableHandoff)) return { acquired: false, reason: '当前实例正在导入、恢复数据，或未能完成保存。请处理后重试。' }
        if (!requestedQuit && (peer.status === 'running' || peer.retryableHandoff)) {
          const reply = await requestEdition(options.endpoint, { ...request, action: 'shutdown', executable: peer.executable })
          requestedQuit = reply.status === 'yielding'
          if (reply.status === 'denied') return { acquired: false, reason: '当前运行实例拒绝了社区版的保存接管请求。' }
        }
      }
      if (peer.status === 'denied') return { acquired: false, reason: '当前运行实例的身份不匹配，请从对应安装目录启动。' }
    } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET'].includes((error as NodeJS.ErrnoException).code ?? '')) return { acquired: false, reason: '无法确认另一版本的运行状态：' + (error as Error).message }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return { acquired: false, reason: '当前实例尚未完成保存退出，请处理保存或关闭确认后重试。' }
}
