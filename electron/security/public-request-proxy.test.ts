import http from 'node:http'
import type { Duplex } from 'node:stream'
import { text as bodyText } from 'node:stream/consumers'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ proxy: '' }))
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]) }))
vi.mock('../store/app-settings-repository.js', () => ({ readSettingsRaw: () => ({ proxyMode: 'custom', customProxy: state.proxy, proxyUsername: 'fixture', proxyPassword: 'controlled' }) }))
import { withPublicResponse } from './public-request.js'

interface Reply { status?: number; headers?: Record<string, string | string[]>; body: string | Buffer; leaveOpen?: boolean }

async function controlledProxy(reply: (request: string) => Reply) {
  const connections: Array<{ target?: string; headers: http.IncomingHttpHeaders }> = []
  const requests: string[] = []
  const sockets = new Set<Duplex>()
  const server = http.createServer()
  server.on('connect', (request, socket) => {
    connections.push({ target: request.url, headers: request.headers }); sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.once('end', () => socket.end())
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    let received = '', finished = false
    socket.on('data', bytes => {
      if (finished) return
      received += bytes.toString('utf8')
      if (!received.includes('\r\n\r\n')) return
      finished = true; requests.push(received)
      const result = reply(received)
      const body = Buffer.from(result.body)
      const headers = Object.entries({ 'Content-Length': String(body.length), Connection: 'close', ...result.headers })
        .flatMap(([name, values]) => (Array.isArray(values) ? values : [values]).map(value => `${name}: ${value}`))
      const bytesOut = Buffer.concat([Buffer.from(`HTTP/1.1 ${result.status || 200} Result\r\n${headers.join('\r\n')}\r\n\r\n`), body])
      if (result.leaveOpen) socket.write(bytesOut)
      else socket.end(bytesOut)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Loopback proxy did not listen')
  state.proxy = `http://127.0.0.1:${address.port}`
  const session = { resolveProxy: vi.fn(async () => `PROXY 127.0.0.1:${address.port}`), getUserAgent: () => 'controlled-client',
    cookies: { get: vi.fn(async (_filter: { url: string }): Promise<Array<{ name: string; value: string }>> => []), set: vi.fn(async (_details: Record<string, unknown>) => {}) } }
  return { session, connections, requests, sockets, close: async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  } }
}

it('uses a real loopback CONNECT tunnel for a checked public destination', async () => {
  const proxy = await controlledProxy(() => ({ body: 'controlled proxy response' }))
  proxy.session.cookies.get.mockResolvedValue([{ name: 'fixture', value: 'controlled-cookie' }])
  try {
    const body = await withPublicResponse(proxy.session as any, 'http://public.fixture:8080/document?value=1', AbortSignal.timeout(5000), response => bodyText(response.body))
    expect(body).toBe('controlled proxy response')
    expect(proxy.connections).toHaveLength(1)
    expect(proxy.connections[0].target).toBe('8.8.8.8:8080')
    expect(proxy.connections[0].headers['proxy-authorization']).toBe(`Basic ${Buffer.from('fixture:controlled').toString('base64')}`)
    expect(proxy.requests[0]).toContain('GET /document?value=1 HTTP/1.1\r\n')
    expect(proxy.requests[0]).toMatch(/\r\nhost: public\.fixture:8080\r\n/i)
    expect(proxy.requests[0]).toMatch(/\r\ncookie: fixture=controlled-cookie\r\n/i)
    expect(proxy.requests[0]).not.toMatch(/proxy-authorization/i)
    expect(proxy.session.resolveProxy).toHaveBeenCalledWith('http://public.fixture:8080/document?value=1')
    expect(proxy.session.cookies.get).toHaveBeenCalledWith({ url: 'http://public.fixture:8080/document?value=1' })
  } finally { await proxy.close() }
}, 10000)

it.each(['gzip', 'br'])('decodes a real %s response before consumption', async encoding => {
  const contents = Buffer.from('controlled compressed document '.repeat(2000))
  const compressed = encoding === 'gzip' ? gzipSync(contents) : brotliCompressSync(contents)
  const proxy = await controlledProxy(() => ({ headers: { 'Content-Encoding': encoding }, body: compressed }))
  try {
    expect(await withPublicResponse(proxy.session as any, 'http://public.fixture/document', AbortSignal.timeout(5000), response => bodyText(response.body))).toBe(contents.toString('utf8'))
  } finally { await proxy.close() }
})

it('writes response cookies to the same session before the next original URL request', async () => {
  const proxy = await controlledProxy(request => request.startsWith('GET /start ')
    ? { status: 302, headers: { Location: '/next', 'Set-Cookie': 'fixture=refreshed; Domain=public.fixture; Path=/; HttpOnly; SameSite=Lax; Max-Age=120' }, body: '' }
    : { body: 'session refreshed' })
  let cookies: Array<{ name: string; value: string }> = []
  proxy.session.cookies.get.mockImplementation(async () => cookies)
  proxy.session.cookies.set.mockImplementation(async details => { cookies = [{ name: String(details.name), value: String(details.value) }] })
  const before = Date.now() / 1000
  try {
    expect(await withPublicResponse(proxy.session as any, 'http://public.fixture/start', AbortSignal.timeout(5000), response => bodyText(response.body))).toBe('session refreshed')
    expect(proxy.session.cookies.set).toHaveBeenCalledOnce()
    expect(proxy.session.cookies.set.mock.calls[0][0]).toMatchObject({ url: 'http://public.fixture/start', name: 'fixture', value: 'refreshed',
      domain: 'public.fixture', path: '/', httpOnly: true, secure: false, sameSite: 'lax' })
    expect(proxy.session.cookies.set.mock.calls[0][0].expirationDate).toBeGreaterThanOrEqual(before + 119)
    expect(proxy.requests[0]).not.toMatch(/\r\ncookie:/i)
    expect(proxy.requests[1]).toMatch(/\r\ncookie: fixture=refreshed\r\n/i)
  } finally { await proxy.close() }
})

it('keeps host-only response cookies scoped to their origin across redirects', async () => {
  const proxy = await controlledProxy(request => /\r\nhost: public\.fixture\r\n/i.test(request)
    ? { status: 302, headers: { Location: 'http://other.fixture/next', 'Set-Cookie': ['origin=private; Path=/', 'foreign=blocked; Domain=other.fixture; Path=/'] }, body: '' }
    : { body: 'other origin' })
  const stored: Array<Record<string, unknown>> = []
  proxy.session.cookies.set.mockImplementation(async details => { stored.push(details) })
  proxy.session.cookies.get.mockImplementation(async ({ url }) => stored.filter(cookie => new URL(String(cookie.url)).hostname === new URL(url).hostname)
    .map(cookie => ({ name: String(cookie.name), value: String(cookie.value) })))
  try {
    expect(await withPublicResponse(proxy.session as any, 'http://public.fixture/start', AbortSignal.timeout(5000), response => bodyText(response.body))).toBe('other origin')
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ url: 'http://public.fixture/start', name: 'origin', path: '/' })
    expect(stored[0]).not.toHaveProperty('domain')
    expect(proxy.requests[1]).not.toMatch(/\r\ncookie:/i)
    expect(proxy.session.cookies.get).toHaveBeenLastCalledWith({ url: 'http://other.fixture/next' })
  } finally { await proxy.close() }
})

it('allows a consumer to stop on decoded bytes before buffering a compressed resource', async () => {
  const contents = Buffer.from('controlled resource '.repeat(200000))
  const compressed = gzipSync(contents)
  expect(compressed.length).toBeLessThan(16384)
  const proxy = await controlledProxy(() => ({ headers: { 'Content-Encoding': 'gzip' }, body: compressed }))
  try {
    const consumed = await withPublicResponse(proxy.session as any, 'http://public.fixture/resource', AbortSignal.timeout(5000), async response => {
      let size = 0
      for await (const part of response.body) { size += part.byteLength; if (size >= 16384) break }
      return size
    })
    expect(consumed).toBeGreaterThanOrEqual(16384)
    expect(consumed).toBeLessThan(contents.length)
  } finally { await proxy.close() }
})

it('closes an unconsumed response when its consumer throws', async () => {
  const proxy = await controlledProxy(() => ({ headers: { 'Content-Length': '1000000' }, body: 'partial', leaveOpen: true }))
  try {
    await expect(withPublicResponse(proxy.session as any, 'http://public.fixture/document', AbortSignal.timeout(5000), async () => { throw new Error('Controlled consumer failure') })).rejects.toThrow('Controlled consumer failure')
    await new Promise<void>(resolve => setTimeout(resolve, 20))
    expect(proxy.sockets.size).toBe(0)
  } finally { await proxy.close() }
})

it('cancels an active response without waiting for its unfinished body', async () => {
  const proxy = await controlledProxy(() => ({ headers: { 'Content-Length': '1000000' }, body: 'partial', leaveOpen: true }))
  const controller = new AbortController()
  try {
    await expect(withPublicResponse(proxy.session as any, 'http://public.fixture/document', controller.signal, async response => {
      for await (const _part of response.body) controller.abort()
    })).rejects.toThrow()
    await new Promise<void>(resolve => setTimeout(resolve, 20))
    expect(proxy.sockets.size).toBe(0)
  } finally { await proxy.close() }
})
