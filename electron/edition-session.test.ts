import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type net from 'node:net'
import { acquireEditionSession, editionSessionEndpoint, requestEdition, type SessionOptions } from './edition-session.js'

const servers: net.Server[] = []
afterEach(async () => { await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve())))); servers.length = 0 })
function options(edition: SessionOptions['edition'], endpoint = editionSessionEndpoint(randomUUID())): SessionOptions {
  return { edition, endpoint, executable: 'E:/test/SidekickAI-OpenSource.exe', state: () => 'ready', onActivate: vi.fn(), onQuit: vi.fn(), timeoutMs: 800 }
}
async function acquire(value: SessionOptions) {
  const result = await acquireEditionSession(value)
  if (result.acquired) servers.push(result.server)
  return result
}

describe('edition ownership', () => {
  it('refuses open-source activation while online owns the session', async () => {
    const online = options('online')
    expect((await acquire(online)).acquired).toBe(true)
    expect((await acquire(options('open-source', online.endpoint))).acquired).toBe(false)
    expect(online.onQuit).not.toHaveBeenCalled()
  })
  it('activates an existing same-edition instance', async () => {
    const first = options('open-source')
    await acquire(first)
    expect((await acquire(options('open-source', first.endpoint))).acquired).toBe(false)
    expect(first.onActivate).toHaveBeenCalledOnce()
  })
  it('waits for ownership release after requesting graceful shutdown', async () => {
    const first = options('open-source')
    const running = await acquire(first)
    if (!running.acquired) throw new Error('Missing owner')
    first.onQuit = vi.fn(() => { setTimeout(() => running.server.close(), 180) })
    const start = Date.now()
    expect((await acquire(options('online', first.endpoint))).acquired).toBe(true)
    expect(Date.now() - start).toBeGreaterThanOrEqual(180)
    expect(first.onQuit).toHaveBeenCalledOnce()
  })
  it('preserves an owner that cannot finish saving', async () => {
    const first = options('open-source')
    await acquire(first)
    expect((await acquire(options('online', first.endpoint))).acquired).toBe(false)
    expect(first.onQuit).toHaveBeenCalledOnce()
  })
  it('does not interrupt an active import', async () => {
    const first = options('open-source')
    first.state = () => 'busy'
    await acquire(first)
    expect((await acquire(options('online', first.endpoint))).acquired).toBe(false)
    expect(first.onQuit).not.toHaveBeenCalled()
    expect((await requestEdition(first.endpoint, { protocol: 1, edition: 'online', action: 'status' })).status).toBe('busy')
  })
  it('binds installer shutdown to the exact open-source executable', async () => {
    const first = options('open-source')
    await acquire(first)
    const send = (executable: string) => requestEdition(first.endpoint, { protocol: 1, edition: 'open-source', action: 'shutdown', executable })
    expect((await send('E:/foreign/SidekickAI.exe')).status).toBe('denied')
    expect(first.onQuit).not.toHaveBeenCalled()
    expect((await send(first.executable)).status).toBe('yielding')
  })
})
