import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type net from 'node:net'
import { acquireEditionSession, editionSessionEndpoint, requestEdition, type SessionOptions } from './edition-session.js'

const servers: net.Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})
function options(edition: SessionOptions['edition'], namespace: string = randomUUID(), profile = 'E:/fixture/profile'): SessionOptions {
  return { edition, endpoint: editionSessionEndpoint(namespace, edition, profile), executable: `E:/fixture/${edition}/SidekickAI.exe`, legacyApplications: () => [], state: () => 'ready', onActivate: vi.fn(), onQuit: vi.fn(), timeoutMs: 1000 }
}
async function acquire(value: SessionOptions) {
  const result = await acquireEditionSession(value)
  if (result.acquired) servers.push(result.server)
  return result
}

describe('community-priority exclusive application ownership', () => {
  it('refuses a verified historical process that does not implement the shared endpoint', async () => {
    const current = options('community')
    current.legacyApplications = () => [{ pid: 123, executable: 'E:/old/SidekickAI.exe', edition: 'community', version: '0.1.0-beta.4' }]
    expect(await acquire(current)).toMatchObject({ acquired: false, outcome: 'unavailable' })
    expect((await acquire({ ...current, legacyApplications: () => [] })).acquired).toBe(true)
  })
  it('activates community when concept is opened, including a different portable profile', async () => {
    const namespace = randomUUID()
    const community = options('community', namespace)
    expect((await acquire(community)).acquired).toBe(true)
    const concept = options('concept', namespace, 'E:/portable/data')
    expect((await acquire(concept)).acquired).toBe(false)
    expect(community.onActivate).toHaveBeenCalledOnce()
    expect(community.onQuit).not.toHaveBeenCalled()
    expect(concept.onQuit).not.toHaveBeenCalled()
  })
  it('waits for concept to save and release ownership before starting community', async () => {
    const namespace = randomUUID()
    const concept = options('concept', namespace)
    const current = await acquire(concept)
    expect(current.acquired).toBe(true)
    if (!current.acquired) throw new Error('Missing concept owner')
    let saved = false
    concept.onQuit = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 30))
      saved = true
      await new Promise<void>(resolve => current.server.close(() => resolve()))
      return true
    })
    const community = await acquire(options('community', namespace))
    expect(community.acquired).toBe(true)
    expect(saved).toBe(true)
    expect(current.server.listening).toBe(false)
    expect(concept.onQuit).toHaveBeenCalledOnce()
  })
  it('redirects a concurrent community takeover after another community becomes owner', async () => {
    const namespace = randomUUID()
    const concept = options('concept', namespace)
    const current = await acquire(concept)
    if (!current.acquired) throw new Error('Missing concept owner')
    concept.onQuit = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 30)); await new Promise<void>(resolve => current.server.close(() => resolve())); return true })
    const results = await Promise.all([acquire(options('community', namespace)), acquire(options('community', namespace))])
    expect(results.filter(result => result.acquired)).toHaveLength(1)
    expect(results.find(result => !result.acquired)).toMatchObject({ acquired: false, reason: expect.stringContaining('已切换到现有窗口') })
    expect(concept.onQuit).toHaveBeenCalledOnce()
  })
  it('keeps concept running if saving rejects', async () => {
    const namespace = randomUUID()
    const concept = options('concept', namespace)
    concept.onQuit = vi.fn(() => false)
    const current = await acquire(concept)
    const result = await acquire(options('community', namespace))
    expect(result.acquired).toBe(false)
    expect(current.acquired && current.server.listening).toBe(true)
    expect(concept.onQuit).toHaveBeenCalledOnce()
    if (!current.acquired) throw new Error('Missing concept owner')
    concept.onQuit = vi.fn(async () => { await new Promise<void>(resolve => current.server.close(() => resolve())); return true })
    expect((await acquire(options('community', namespace))).acquired).toBe(true)
    expect(concept.onQuit).toHaveBeenCalledOnce()
  })
  it('asks a busy owner to complete bounded saving for a community takeover', async () => {
    const namespace = randomUUID()
    const concept = options('concept', namespace)
    concept.state = () => 'busy'
    const owner = await acquire(concept)
    if (!owner.acquired) throw new Error('Missing concept owner')
    concept.onQuit = vi.fn(async () => { await new Promise<void>(resolve => owner.server.close(() => resolve())); return true })
    expect((await acquire(options('community', namespace))).acquired).toBe(true)
    expect(concept.onQuit).toHaveBeenCalledOnce()
  })
  it('activates the existing same-edition instance across different data roots', async () => {
    const namespace = randomUUID()
    const first = options('concept', namespace, 'E:/portable-a/data')
    await acquire(first)
    expect((await acquire(options('concept', namespace, 'E:/portable-b/data'))).acquired).toBe(false)
    expect(first.onActivate).toHaveBeenCalledOnce()
    expect(first.onQuit).not.toHaveBeenCalled()
  })
  it('hands over a different concept version without a policy rejection', async () => {
    const namespace = randomUUID()
    const first = { ...options('concept', namespace), version: '0.1.0-beta.4' }
    const owner = await acquire(first)
    if (!owner.acquired) throw new Error('Missing concept owner')
    first.onQuit = vi.fn(async () => { await new Promise<void>(resolve => owner.server.close(() => resolve())); return true })
    const result = await acquire(options('community', namespace))
    expect(result.acquired).toBe(true)
    expect(first.onActivate).not.toHaveBeenCalled()
    expect(first.onQuit).toHaveBeenCalledOnce()
  })
  it('does not let concept shut down community', async () => {
    const community = options('community')
    await acquire(community)
    const reply = await requestEdition(community.endpoint, { protocol: 1, edition: 'concept', action: 'shutdown', executable: community.executable, version: '0.1.0-beta.5' })
    expect(reply.status).toBe('denied')
    expect(community.onQuit).not.toHaveBeenCalled()
  })
  it('binds takeover to the exact target executable and matching product version', async () => {
    const concept = options('concept')
    await acquire(concept)
    for (const value of [{ executable: 'E:/foreign/SidekickAI.exe', version: '0.1.0-beta.5' }, { executable: concept.executable, version: '0.1.0-beta.4' }]) {
      expect((await requestEdition(concept.endpoint, { protocol: 1, edition: 'community', action: 'shutdown', ...value })).status).toBe('denied')
    }
    expect(concept.onQuit).not.toHaveBeenCalled()
  })
  it('waits until a starting community instance can activate its window', async () => {
    const namespace = randomUUID()
    const community = options('community', namespace)
    let ready = false
    community.state = () => ready ? 'ready' : 'starting'
    await acquire(community)
    setTimeout(() => { ready = true }, 50)
    expect((await acquire(options('concept', namespace))).acquired).toBe(false)
    expect(community.onActivate).toHaveBeenCalledOnce()
  })
})
