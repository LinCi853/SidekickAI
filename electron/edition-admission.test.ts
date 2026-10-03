import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type net from 'node:net'
import { acquireEditionSession, editionSessionEndpoint, type SessionOptions } from '../packages/desktop-common/edition-session'
import type { ApplicationProcessControl } from '../packages/desktop-common/running-application'
import type { InstallationReservation } from '../packages/desktop-common/installation-reservation'

const servers: net.Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

it('activates a newer community version when concept is opened', async () => {
  const namespace = randomUUID()
  const community = options('community', namespace)
  await acquire(community)
  expect(await acquire(options('concept', namespace))).toMatchObject({ acquired: false, outcome: 'activated' })
  expect(community.onActivate).toHaveBeenCalledOnce()
  expect(community.onQuit).not.toHaveBeenCalled()
})

function processControl(server: net.Server, verify = true): ApplicationProcessControl {
  return { inventory: async () => [], verify: vi.fn(async () => verify), activate: vi.fn(async () => false), close: vi.fn(),
    terminate: vi.fn(async () => { await new Promise<void>(resolve => server.close(() => resolve())) }) }
}
it('terminates only a verified owner after cooperative saving rejects', async () => {
  const namespace = randomUUID()
  const concept = options('concept', namespace)
  concept.onQuit = vi.fn(async () => false)
  const owner = await acquire(concept)
  if (!owner.acquired) throw new Error('Missing fixture owner')
  const control = processControl(owner.server)
  expect((await acquire({ ...options('community', namespace), processControl: control })).acquired).toBe(true)
  expect(concept.onQuit).toHaveBeenCalledOnce()
  expect(control.terminate).toHaveBeenCalledOnce()
})
it('waits for asynchronous activation before returning success', async () => {
  const namespace = randomUUID()
  const community = options('community', namespace)
  let activated = false
  community.onActivate = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 30)); activated = true; return true })
  await acquire(community)
  expect(await acquire(options('concept', namespace))).toMatchObject({ acquired: false, outcome: 'activated' })
  expect(activated).toBe(true)
})
it('waits for a recreated window to load instead of terminating its healthy owner', async () => {
  const namespace = randomUUID()
  const community = options('community', namespace)
  let starting = false
  let recreated = false
  community.state = () => starting ? 'starting' : 'ready'
  community.onActivate = vi.fn(() => {
    if (!recreated) { recreated = true; starting = true; setTimeout(() => { starting = false }, 50); return false }
    return true
  })
  const owner = await acquire(community)
  if (!owner.acquired) throw new Error('Missing fixture owner')
  const control = processControl(owner.server)
  expect(await acquire({ ...options('concept', namespace), processControl: control })).toMatchObject({ acquired: false, outcome: 'activated' })
  expect(control.terminate).not.toHaveBeenCalled()
  expect(community.onActivate).toHaveBeenCalledTimes(2)
})
it('restarts an unhealthy community owner when concept is opened', async () => {
  const namespace = randomUUID()
  const community = options('community', namespace)
  community.onActivate = vi.fn(async () => false)
  const owner = await acquire(community)
  if (!owner.acquired) throw new Error('Missing fixture owner')
  const control = processControl(owner.server)
  expect(await acquire({ ...options('concept', namespace), processControl: control })).toMatchObject({ acquired: false, outcome: 'redirected', targetExecutable: community.executable, targetEdition: 'community' })
  expect(control.terminate).toHaveBeenCalledOnce()
})
it('refuses forged process identity without calling termination', async () => {
  const namespace = randomUUID()
  const owner = await acquire(options('concept', namespace))
  if (!owner.acquired) throw new Error('Missing fixture owner')
  const control = processControl(owner.server, false)
  expect(await acquire({ ...options('community', namespace), processControl: control })).toMatchObject({ acquired: false, outcome: 'unavailable' })
  expect(control.terminate).not.toHaveBeenCalled()
})
it('installation completion opens the selected concept instead of community priority', async () => {
  const namespace = randomUUID()
  const community = options('community', namespace)
  const owner = await acquire(community)
  if (!owner.acquired) throw new Error('Missing fixture owner')
  community.onQuit = vi.fn(async () => { await new Promise<void>(resolve => owner.server.close(() => resolve())); return true })
  expect((await acquire({ ...options('concept', namespace), intent: 'installation', requestId: 'a'.repeat(64) })).acquired).toBe(true)
})
it('ordinary community activation cannot interrupt the installation target', async () => {
  const namespace = randomUUID()
  const concept: SessionOptions = { ...options('concept', namespace), intent: 'installation', requestId: 'a'.repeat(64) }
  const reservation: InstallationReservation = { protocol: 1, requestId: concept.requestId!, executable: concept.executable, edition: 'concept', version: concept.version!,
    pid: process.pid, ownerExecutable: process.execPath, ownerStarted: '1', sid: 'fixture', session: 1, expiresAt: Date.now() + 60000 }
  concept.reservation = async () => reservation
  await acquire(concept)
  expect(await acquire({ ...options('community', namespace), reservation: async () => reservation })).toMatchObject({ acquired: false, outcome: 'activated' })
  expect(concept.onQuit).not.toHaveBeenCalled()
})

it('a different installation request cannot force the protected target', async () => {
  const namespace = randomUUID()
  const concept: SessionOptions = { ...options('concept', namespace), intent: 'installation', requestId: 'a'.repeat(64) }
  const reservation: InstallationReservation = { protocol: 1, requestId: concept.requestId!, executable: concept.executable, edition: 'concept', version: concept.version!,
    pid: process.pid, ownerExecutable: process.execPath, ownerStarted: '1', sid: 'fixture', session: 1, expiresAt: Date.now() + 60000 }
  concept.reservation = async () => reservation
  const owner = await acquire(concept)
  if (!owner.acquired) throw new Error('Missing fixture owner')
  const control = processControl(owner.server)
  expect(await acquire({ ...options('community', namespace), intent: 'installation', requestId: 'b'.repeat(64), reservation: async () => reservation, processControl: control })).toMatchObject({ acquired: false, outcome: 'activated' })
  expect(control.terminate).not.toHaveBeenCalled()
  expect(concept.onQuit).not.toHaveBeenCalled()
})

it('ordinary priority resumes after installation verification releases its reservation', async () => {
  const namespace = randomUUID()
  const concept: SessionOptions = { ...options('concept', namespace), intent: 'installation', requestId: 'a'.repeat(64) }
  let current: InstallationReservation | null = { protocol: 1, requestId: concept.requestId!, executable: concept.executable, edition: 'concept', version: concept.version!,
    pid: process.pid, ownerExecutable: process.execPath, ownerStarted: '1', sid: 'fixture', session: 1, expiresAt: Date.now() + 60000 }
  concept.reservation = async () => current
  const owner = await acquire(concept)
  if (!owner.acquired) throw new Error('Missing fixture owner')
  concept.onQuit = vi.fn(async () => { await new Promise<void>(resolve => owner.server.close(() => resolve())); return true })
  current = null
  expect((await acquire({ ...options('community', namespace), reservation: async () => current })).acquired).toBe(true)
})
function options(edition: SessionOptions['edition'], namespace: string): SessionOptions {
  return { edition, version: edition === 'concept' ? '0.1.6' : '0.1.5-beta-rc',
    endpoint: editionSessionEndpoint(namespace), executable: `E:/fixture/${edition}/SidekickAI.exe`,
    legacyApplications: () => [], state: () => 'ready', onActivate: vi.fn(), onQuit: vi.fn(), timeoutMs: 1000 }
}
async function acquire(value: SessionOptions) {
  const result = await acquireEditionSession(value)
  if (result.acquired) servers.push(result.server)
  return result
}

it('community replaces a different concept version after saving', async () => {
  const namespace = randomUUID()
  const concept = options('concept', namespace)
  const owner = await acquire(concept)
  if (!owner.acquired) throw new Error('Missing fixture owner')
  concept.onQuit = vi.fn(async () => {
    await new Promise<void>(resolve => owner.server.close(() => resolve()))
    return true
  })
  expect((await acquire(options('community', namespace))).acquired).toBe(true)
  expect(concept.onQuit).toHaveBeenCalledOnce()
})
