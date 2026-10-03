import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { product } from '../product-contract'
import { applicationProcessOperation, applicationProcessOperationSync, prepareEditionSession } from './application-process'
import { readInstallationReservation, type InstallationReservation } from './installation-reservation'
import { runningApplications, packageIdentity, applicationProcessControl, type ApplicationProcessControl, type RunningApplication } from './running-application.js'
export { prepareEditionSession } from './application-process'
export { applicationSessionIntent } from './installation-reservation'

export type Edition = 'concept' | 'community'
type Intent = 'ordinary' | 'installation'
type Reply = { protocol: 1; edition: Edition; version: string; executable: string; pid: number; retryableHandoff?: boolean; intent?: Intent; requestId?: string; status: 'running' | 'yielding' | 'busy' | 'starting' | 'denied' }
type Request = { protocol: 1; edition: Edition; version?: string; action: 'activate' | 'shutdown' | 'status'; executable?: string; intent?: Intent; requestId?: string }
export type SessionOptions = {
  edition: Edition; endpoint: string; executable: string; version?: string; intent?: Intent; requestId?: string; resourcesPath?: string
  legacyApplications?: () => RunningApplication[]
  processControl?: ApplicationProcessControl
  reservation?: () => Promise<InstallationReservation | null>
  state: () => 'ready' | 'busy' | 'starting'
  onActivate: () => void | boolean | Promise<void | boolean>
  onQuit: () => void | boolean | Promise<void | boolean>
  timeoutMs?: number
}
export type SessionResult = { acquired: true; server: net.Server } | { acquired: false; outcome: 'activated' | 'redirected' | 'unavailable'; reason: string; failure?: 'access-denied' | 'identity-mismatch' | 'waiting'; targetExecutable?: string; targetEdition?: Edition }

/** Editions and portable profiles share one application owner per interactive session. */
export function editionSessionEndpoint(testNamespace?: string, _edition: Edition = 'concept', _profile = '', resourcesPath?: string): string {
  let session = process.env.XDG_SESSION_ID || process.env.DISPLAY || 'desktop'
  if (!testNamespace && process.platform === 'win32') {
    session = resourcesPath ? String(applicationProcessOperationSync<number>('session', { pid: process.pid }, resourcesPath))
      : execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Process -Id ' + process.pid + ').SessionId'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim()
    if (!/^\d+$/.test(session)) throw new Error('Cannot identify the interactive session')
  }
  const namespace = testNamespace ? 'test:' + testNamespace : os.homedir().toLowerCase() + '|' + session
  const hash = createHash('sha256').update(namespace + '|exclusive-application').digest('hex').slice(0, 24)
  return process.platform === 'win32' ? '\\\\.\\pipe\\sidekick-editions-' + hash : path.join(os.tmpdir(), 'sidekick-editions-' + hash + '.sock')
}
function validateReply(value: Reply): Reply {
  if (value.protocol !== 1 || !['concept', 'community'].includes(value.edition) || typeof value.version !== 'string' || !value.version || typeof value.executable !== 'string' || !path.isAbsolute(value.executable) || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !['running', 'yielding', 'busy', 'starting', 'denied'].includes(value.status)) throw new Error('Unknown edition protocol')
  return value
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
      try { const value = validateReply(JSON.parse(received.split('\n')[0]) as Reply); socket.destroy(); resolve(value) }
      catch (error) { fail(error as Error) }
    })
    socket.once('end', () => { if (!received.includes('\n')) fail(new Error('Incomplete edition response')) })
  })
}
const equalPath = (left: string, right: string) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
const pause = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds))
const unavailable = (reason: string, error?: unknown): SessionResult => ({ acquired: false, outcome: 'unavailable', reason, failure: (error as NodeJS.ErrnoException | undefined)?.code === 'EACCES' ? 'access-denied' : (error as NodeJS.ErrnoException | undefined)?.code === 'EIDENTITY' ? 'identity-mismatch' : 'waiting' })
const redirected = (owner: RunningApplication): SessionResult => ({ acquired: false, outcome: 'redirected', reason: '正在重新打开已有工百窗。', targetExecutable: owner.executable, targetEdition: owner.edition })
const activated = (): SessionResult => ({ acquired: false, outcome: 'activated', reason: '工百窗已在运行，已切换到现有窗口。' })
function reservationFor(options: SessionOptions) {
  return options.reservation ?? (() => options.legacyApplications || process.env.SIDEKICK_TEST_SESSION ? Promise.resolve(null) : readInstallationReservation(options.endpoint, options.resourcesPath))
}
function ownsInstallation(options: SessionOptions, reservation: InstallationReservation | null, requestId: string, version: string): boolean {
  return options.intent === 'installation' && (reservation
    ? reservation.requestId === requestId && equalPath(reservation.executable, options.executable) && reservation.edition === options.edition && reservation.version === version
    : !!options.legacyApplications)
}
function listen(options: SessionOptions, admitted: () => boolean): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const version = options.version ?? product.version
    let quitting = false
    let saveRejected = false
    let savingRequest: string | undefined
    const server = net.createServer(socket => {
      let received = ''
      socket.setTimeout(5000, () => socket.destroy())
      socket.on('error', () => socket.destroy())
      socket.on('data', chunk => {
        received += chunk.toString('utf8')
        if (received.length > 4096) return socket.destroy()
        if (!received.includes('\n')) return
        socket.removeAllListeners('data')
        void (async () => {
          let status: Reply['status'] = 'denied'
          let quit = false
          let protectedInstallation = false
          try {
            const request = JSON.parse(received.split('\n')[0]) as Request
            if (request.protocol !== 1 || !['concept', 'community'].includes(request.edition)) throw new Error('Unknown edition request')
            const reservation = await reservationFor(options)()
            protectedInstallation = !!reservation && reservation.requestId === options.requestId && equalPath(reservation.executable, options.executable)
            const matchingInstallation = request.intent === 'installation' && (reservation ? request.requestId === reservation.requestId : !!options.legacyApplications)
            const sameEdition = request.edition === options.edition
            const communityTakeover = options.edition === 'concept' && request.edition === 'community'
            const state = admitted() ? options.state() : 'starting'
            const shutdown = request.action === 'shutdown' && (sameEdition || communityTakeover || matchingInstallation) && (request.version === undefined || request.version === version) && typeof request.executable === 'string' && equalPath(request.executable, options.executable) && (!protectedInstallation || matchingInstallation)
            if (request.action === 'status') status = saveRejected ? 'busy' : quitting ? 'yielding' : state === 'ready' ? 'running' : state
            else if (shutdown) {
              if (savingRequest !== request.requestId) saveRejected = false
              status = state === 'starting' ? 'starting' : 'yielding'
              quit = status === 'yielding' && !quitting && !saveRejected
              if (quit) { quitting = true; savingRequest = request.requestId }
            } else if (request.action === 'activate') {
              if (quitting) status = 'yielding'
              else if (state === 'starting') status = 'starting'
              else if (await options.onActivate() === false) status = options.state() === 'starting' ? 'starting' : 'busy'
              else status = 'running'
            }
          } catch { status = 'denied' }
          socket.end(JSON.stringify({ protocol: 1, edition: options.edition, version, executable: options.executable, pid: process.pid, status, intent: protectedInstallation ? 'installation' : 'ordinary', requestId: protectedInstallation ? options.requestId : undefined, retryableHandoff: saveRejected } satisfies Reply) + '\n', () => {
            if (quit) Promise.resolve().then(() => options.onQuit()).then(accepted => { if (accepted === false) { quitting = false; saveRejected = true } }).catch(() => { quitting = false; saveRejected = true })
          })
        })()
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
/** The reservation is acquired before profile locks or persistent stores are opened. */
export async function acquireEditionSession(options: SessionOptions): Promise<SessionResult> {
  const deadline = Date.now() + (options.timeoutMs ?? 30000)
  const version = options.version ?? product.version
  const requestId = options.requestId ?? randomBytes(32).toString('hex')
  const control = options.processControl ?? (!options.legacyApplications && process.platform === 'win32' && !process.env.SIDEKICK_TEST_SESSION ? applicationProcessControl(options.resourcesPath) : undefined)
  const inventory = options.legacyApplications ?? (options.processControl ? control?.inventory : control ? async () => (await control.inventory()).filter(owner => {
    return packageIdentity(path.join(path.dirname(owner.executable), 'resources/app.asar'))?.editionSessionProtocol !== 2
  }) : undefined) ?? (() => runningApplications(false, options.resourcesPath))
  const request = { protocol: 1 as const, edition: options.edition, version, intent: options.intent ?? 'ordinary', requestId }
  const send = async (value: Request) => control && !options.processControl ? validateReply(await applicationProcessOperation<Reply>('request', { endpoint: options.endpoint, request: value, timeoutMs: 1500 }, options.resourcesPath)) : requestEdition(options.endpoint, value)
  let target: RunningApplication | undefined
  let quitRequested = false
  let unhealthy = false
  while (Date.now() < deadline) {
    const reservation = await reservationFor(options)().catch(() => null)
    const installationOwner = ownsInstallation(options, reservation, requestId, version)
    if (!reservation || installationOwner || !!options.legacyApplications && options.intent === 'installation') {
      try {
        let admitted = false
        const server = await listen(options, () => admitted)
        try {
          if (!options.legacyApplications && !options.processControl) await prepareEditionSession(options.endpoint, options.resourcesPath)
          const existing = await inventory()
          for (const owner of existing) {
            if (!control || !await control.verify(owner)) throw new Error('无法核实已有工百窗的进程身份。')
            const preferOwner = !installationOwner && (owner.edition === 'community' || owner.edition === options.edition)
            if (preferOwner && await control.activate(owner)) { await new Promise<void>(resolve => server.close(() => resolve())); return activated() }
            await Promise.resolve(control.close(owner)).catch(() => undefined)
            while (Date.now() < deadline && (await inventory()).some(value => value.pid === owner.pid)) await pause(100)
            if ((await inventory()).some(value => value.pid === owner.pid)) await control.terminate(owner)
            if (preferOwner && !equalPath(owner.executable, options.executable)) { await new Promise<void>(resolve => server.close(() => resolve())); return redirected(owner) }
          }
          admitted = true
          return { acquired: true, server }
        } catch (error) {
          await new Promise<void>(resolve => server.close(() => resolve()))
          return unavailable((error as Error).message, error)
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') return unavailable((error as Error).message, error) }
    }
    try {
      const peer = await send({ ...request, action: 'status' })
      if (target && (target.edition !== peer.edition || !equalPath(target.executable, peer.executable) || target.pid !== peer.pid)) { quitRequested = false; unhealthy = false }
      target = { pid: peer.pid, executable: peer.executable, edition: peer.edition, version: peer.version }
      if (control && !await control.verify(target)) return unavailable('已有工百窗的协调身份无法核实。', { code: 'EIDENTITY' })
      const protectedInstallation = !!reservation && !installationOwner
      const preferOwner = protectedInstallation || !installationOwner && (peer.edition === 'community' || peer.edition === options.edition)
      if (preferOwner && !unhealthy && !quitRequested) {
        const reply = await send({ ...request, action: 'activate' })
        if (reply.status === 'running') return activated()
        unhealthy = reply.status === 'busy'
      } else if (!protectedInstallation && !quitRequested && (peer.status !== 'starting' || unhealthy)) {
        const reply = await send({ ...request, version: peer.version, action: 'shutdown', executable: peer.executable })
        quitRequested = reply.status === 'yielding'
        unhealthy ||= reply.status === 'denied'
      }
      if (!protectedInstallation && (peer.retryableHandoff || unhealthy) && control) {
        await control.terminate(target)
        if (preferOwner && !equalPath(target.executable, options.executable)) return redirected(target)
        target = undefined; quitRequested = false; unhealthy = false
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EACCES' || code === 'EPERM') return unavailable('正在准备工百窗的权限交接。', error)
      if (code === 'EIDENTITY' || code === 'ECANCELED') return unavailable((error as Error).message, error)
      if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET'].includes(code ?? '') && control) {
        if (!options.processControl) {
          const peer = await applicationProcessOperation<{ pid: number; executable: string; started: string; sid: string; session: number }>('peer', { endpoint: options.endpoint }, options.resourcesPath).catch(() => null)
          if (peer) {
            const identity = packageIdentity(path.join(path.dirname(peer.executable), 'resources/app.asar'))
            const edition = (['community', 'concept'] as const).find(value => product.editions[value].packageName === identity?.name)
            if (identity && edition) target = { ...peer, edition, version: identity.version }
          }
        } else { const owners = await Promise.resolve(control.inventory()).catch(() => []); target ??= owners[0] }
        unhealthy = true
      }
    }
    await pause(100)
  }
  if (target && control) {
    try {
      const reservation = await reservationFor(options)()
      const installationOwner = ownsInstallation(options, reservation, requestId, version)
      if (reservation && !installationOwner) return unavailable('正在打开本次安装的工百窗。')
      await control.terminate(target)
      const preferOwner = !installationOwner && (target.edition === 'community' || target.edition === options.edition)
      if (preferOwner && !equalPath(target.executable, options.executable)) return redirected(target)
      return acquireEditionSession({ ...options, timeoutMs: 5000 })
    } catch (error) { return unavailable((error as Error).message, error) }
  }
  return unavailable('正在等待工百窗完成启动交接。')
}
