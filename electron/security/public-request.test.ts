import { beforeEach, expect, it, vi } from 'vitest'
import { text as bodyText } from 'node:stream/consumers'
const state = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn(), agents: [] as any[], proxies: [] as any[], profile: vi.fn(), settings: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: state.lookup }))
vi.mock('../store/profile-repository.js', () => ({ readProfile: state.profile }))
vi.mock('../store/app-settings-repository.js', () => ({ readSettingsRaw: state.settings }))
vi.mock('undici', async importOriginal => {
  const actual = await importOriginal<typeof import('undici')>()
  return { ...actual, fetch: async (url: unknown, options: unknown) => {
    const result = await state.request(url, options)
    const headers = new actual.Headers()
    for (const [name, value] of Object.entries(result.headers)) {
      for (const item of Array.isArray(value) ? value : [value]) headers.append(name, String(item))
    }
    return new actual.Response(typeof result.body === 'string' ? result.body : null, { status: result.statusCode, headers })
  }, Agent: class {
  options: any
  destroy = vi.fn()
  constructor(options: any) { this.options = options; state.agents.push(this) }
}, ProxyAgent: class {
  options: any
  destroy = vi.fn()
  compose = vi.fn(() => this)
  constructor(options: any) { this.options = options; state.proxies.push(this) }
} } })
import { httpUrl, isPublicAddress, publicDestination, withPublicResponse } from './public-request.js'
beforeEach(() => {
  vi.clearAllMocks(); state.agents.length = 0; state.proxies.length = 0
  state.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]); state.profile.mockReturnValue(undefined); state.settings.mockReturnValue({})
})

it.each(['0.0.0.0', '10.1.2.3', '127.0.0.1', '100.64.1.2', '169.254.169.254', '172.16.0.1', '192.168.1.1',
  '198.18.0.1', '192.0.2.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', '::127.0.0.1',
  'fe80::1', 'fc00::1', 'ff02::1', '64:ff9b::7f00:1', '2002:7f00:1::', '2001:db8::1'])('rejects nonpublic address %s', address => {
  expect(isPublicAddress(address)).toBe(false)
})
it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])('permits public address %s', address => {
  expect(isPublicAddress(address)).toBe(true)
})
it.each(['http://2130706433/', 'http://0x7f000001/', 'http://127.1/', 'http://[::ffff:7f00:1]/'])('rejects alternate private literal %s', async value => {
  await expect(publicDestination(value)).rejects.toThrow('公网')
  expect(state.lookup).not.toHaveBeenCalled()
})
it.each(['file:///C:/secret', 'data:text/plain,secret', 'https://user:pass@example.com/'])('refuses protocol or credentials %s', value => {
  expect(() => httpUrl(value)).toThrow()
})
it('rejects mixed DNS answers before starting the request', async () => {
  state.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }])
  await expect(withPublicResponse({} as any, 'https://public.example', AbortSignal.timeout(1000), vi.fn())).rejects.toThrow('公网')
  expect(state.request).not.toHaveBeenCalled()
})
it('pins the checked address and revalidates redirects before cookies or I/O', async () => {
  const session = { cookies: { get: vi.fn().mockResolvedValue([{ name: 'session', value: 'value' }]) }, getUserAgent: () => 'fixture', resolveProxy: vi.fn().mockResolvedValue('DIRECT') }
  state.request.mockResolvedValue({ statusCode: 302, headers: { location: 'http://169.254.169.254/metadata' }, body: { destroy: vi.fn() } })
  await expect(withPublicResponse(session as any, 'https://public.example', AbortSignal.timeout(1000), vi.fn())).rejects.toThrow('公网')
  expect(state.request).toHaveBeenCalledTimes(1)
  expect(session.cookies.get).toHaveBeenCalledTimes(1)
  const resolved = vi.fn()
  state.agents[0].options.connect.lookup('public.example', { all: true }, resolved)
  expect(resolved).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }])
  expect(state.agents[0].destroy).toHaveBeenCalled()
})
it('reads cookies for each validated origin and closes the response owner', async () => {
  const session = { cookies: { get: vi.fn().mockImplementation(({ url }) => Promise.resolve([{ name: 'site', value: new URL(url).hostname }])) }, getUserAgent: () => 'fixture', resolveProxy: vi.fn().mockResolvedValue('DIRECT') }
  state.request.mockResolvedValueOnce({ statusCode: 302, headers: { location: 'https://second.example/resource' }, body: { destroy: vi.fn() } })
    .mockResolvedValueOnce({ statusCode: 200, headers: {}, body: 'content' })
  expect(await withPublicResponse(session as any, 'https://first.example', AbortSignal.timeout(1000), response => bodyText(response.body))).toBe('content')
  expect(state.request.mock.calls.map(call => call[1].headers.cookie)).toEqual(['site=first.example', 'site=second.example'])
  expect(state.agents.every(agent => agent.destroy.mock.calls.length === 1)).toBe(true)
})

function proxySession(route: string) {
  return { __profileId: 'profile', resolveProxy: vi.fn().mockResolvedValue(route),
    cookies: { get: vi.fn().mockResolvedValue([{ name: 'session', value: 'controlled-cookie' }]) }, getUserAgent: () => 'fixture' }
}

it.each(['PROXY 127.0.0.1:3128', 'HTTPS proxy.fixture:443'])('uses the selected %s with a pinned target and original identity', async route => {
  const session = proxySession(route)
  state.profile.mockReturnValue({ proxyConfig: { proxyMode: 'custom', customProxy: route.startsWith('HTTPS') ? 'https://proxy.fixture:443' : 'http://127.0.0.1:3128',
    proxyUsername: 'controlled-user', proxyPassword: 'controlled-password' } })
  state.request.mockResolvedValue({ statusCode: 200, headers: {}, body: 'controlled contents' })
  expect(await withPublicResponse(session as any, 'https://public.example:444/path?q=1', AbortSignal.timeout(1000), response => bodyText(response.body))).toBe('controlled contents')
  expect(session.resolveProxy).toHaveBeenCalledWith('https://public.example:444/path?q=1')
  expect(session.cookies.get).toHaveBeenCalledWith({ url: 'https://public.example:444/path?q=1' })
  expect(state.request.mock.calls[0][0].href).toBe('https://8.8.8.8:444/path?q=1')
  expect(state.request.mock.calls[0][1].headers).toMatchObject({ host: 'public.example:444', cookie: 'session=controlled-cookie' })
  expect(state.proxies[0].options).toMatchObject({ uri: route.startsWith('HTTPS') ? 'https://proxy.fixture/' : 'http://127.0.0.1:3128/',
    requestTls: { servername: 'public.example' }, token: `Basic ${Buffer.from('controlled-user:controlled-password').toString('base64')}` })
  expect(state.agents).toHaveLength(0); expect(state.proxies[0].destroy).toHaveBeenCalledOnce()
})

it('uses matching global custom proxy credentials when the profile inherits global settings', async () => {
  state.settings.mockReturnValue({ proxyMode: 'custom', customProxy: 'http://proxy.fixture:3128', proxyUsername: 'global-user', proxyPassword: 'global-password' })
  state.request.mockResolvedValue({ statusCode: 200, headers: {}, body: 'contents' })
  await withPublicResponse(proxySession('PROXY proxy.fixture:3128') as any, 'http://public.example/', AbortSignal.timeout(1000), response => bodyText(response.body))
  expect(state.proxies[0].options.token).toBe(`Basic ${Buffer.from('global-user:global-password').toString('base64')}`)
  expect(state.request.mock.calls[0][1].headers).not.toHaveProperty('proxy-authorization')
})

it.each([
  { proxyConfig: { proxyMode: 'custom', customProxy: 'http://proxy.fixture:3128' } },
  { proxyConfig: { proxyMode: 'system', customProxy: 'http://proxy.fixture:3128', proxyUsername: 'profile-user', proxyPassword: 'profile-password' } },
  { proxyConfig: { proxyMode: 'direct', customProxy: 'http://proxy.fixture:3128', proxyUsername: 'profile-user', proxyPassword: 'profile-password' } },
  { proxy: 'http://proxy.fixture:3128' },
])('does not inherit global credentials through an independent profile configuration: %j', async profile => {
  state.profile.mockReturnValue(profile)
  state.settings.mockReturnValue({ proxyMode: 'custom', customProxy: 'http://proxy.fixture:3128', proxyUsername: 'global-user', proxyPassword: 'global-password' })
  state.request.mockResolvedValue({ statusCode: 200, headers: {}, body: 'contents' })
  await withPublicResponse(proxySession('PROXY proxy.fixture:3128') as any, 'https://public.example/', AbortSignal.timeout(1000), response => bodyText(response.body))
  expect(state.proxies[0].options.token).toBeUndefined()
  expect(state.settings).not.toHaveBeenCalled()
})

it.each(['system', 'direct', undefined])('does not send stored custom credentials in global mode %s', async proxyMode => {
  state.settings.mockReturnValue({ proxyMode, customProxy: 'http://proxy.fixture:3128', proxyUsername: 'saved-user', proxyPassword: 'saved-password' })
  state.request.mockResolvedValue({ statusCode: 200, headers: {}, body: 'contents' })
  await withPublicResponse(proxySession('PROXY proxy.fixture:3128') as any, 'https://public.example/', AbortSignal.timeout(1000), response => bodyText(response.body))
  expect(state.proxies[0].options.token).toBeUndefined()
})

it.each(['http://other.fixture:3128', 'http://proxy.fixture:3129', 'https://proxy.fixture:3128', '',
  'http://proxy.fixture:3128/other', 'http://user:password@proxy.fixture:3128', 'http://proxy.fixture:3128?value=1'])('keeps credentials from a different or invalid configured proxy %s', async customProxy => {
  state.profile.mockReturnValue({ proxyConfig: { proxyMode: 'custom', customProxy, proxyUsername: 'private-user', proxyPassword: 'private-password' } })
  state.request.mockResolvedValue({ statusCode: 200, headers: {}, body: 'contents' })
  await withPublicResponse(proxySession('PROXY proxy.fixture:3128') as any, 'https://public.example/', AbortSignal.timeout(1000), response => bodyText(response.body))
  expect(state.proxies[0].options.token).toBeUndefined()
})

it('rechecks proxy mode and destination after a redirect', async () => {
  const session = proxySession('PROXY proxy.fixture:3128')
  state.profile.mockReturnValueOnce({ proxyConfig: { proxyMode: 'custom', customProxy: 'http://proxy.fixture:3128', proxyUsername: 'user', proxyPassword: 'password' } })
    .mockReturnValueOnce({ proxyConfig: { proxyMode: 'system', customProxy: 'http://proxy.fixture:3128', proxyUsername: 'user', proxyPassword: 'password' } })
  state.request.mockResolvedValueOnce({ statusCode: 302, headers: { location: '/next' }, body: { destroy: vi.fn() } })
    .mockResolvedValueOnce({ statusCode: 200, headers: {}, body: 'contents' })
  await withPublicResponse(session as any, 'https://public.example/start', AbortSignal.timeout(1000), response => bodyText(response.body))
  expect(state.proxies.map(proxy => proxy.options.token)).toEqual([`Basic ${Buffer.from('user:password').toString('base64')}`, undefined])
})

it('reports a proxy resolution failure without sending a direct request', async () => {
  const session = proxySession('DIRECT')
  session.resolveProxy.mockRejectedValue(new Error('PAC resolution failed'))
  await expect(withPublicResponse(session as any, 'https://public.example/', AbortSignal.timeout(1000), vi.fn())).rejects.toThrow('代理')
  expect(state.request).not.toHaveBeenCalled(); expect(state.agents).toHaveLength(0); expect(state.proxies).toHaveLength(0)
})

it('pins an IPv6 proxy destination without adding a second authority', async () => {
  state.lookup.mockResolvedValue([{ address: '2606:4700:4700::1111', family: 6 }])
  state.request.mockResolvedValue({ statusCode: 200, headers: {}, body: 'contents' })
  await withPublicResponse(proxySession('PROXY [::1]:3128') as any, 'http://public.example:8080/path', AbortSignal.timeout(1000), response => bodyText(response.body))
  expect(state.request.mock.calls[0][0].href).toBe('http://[2606:4700:4700::1111]:8080/path')
  expect(state.request.mock.calls[0][1].headers.host).toBe('public.example:8080')
  expect(state.proxies[0].options.uri).toBe('http://[::1]:3128/')
})

it.each(['SOCKS5 127.0.0.1:1080; DIRECT', 'QUIC proxy.fixture:443; DIRECT', 'PROXY user:password@proxy.fixture:3128', ''])('refuses an unsupported or invalid proxy result without direct fallback: %s', async route => {
  await expect(withPublicResponse(proxySession(route) as any, 'https://public.example/', AbortSignal.timeout(1000), vi.fn())).rejects.toThrow('代理')
  expect(state.request).not.toHaveBeenCalled(); expect(state.agents).toHaveLength(0); expect(state.proxies).toHaveLength(0)
})

it('does not silently bypass a failed selected proxy', async () => {
  state.request.mockRejectedValue(new Error('Connection refused'))
  await expect(withPublicResponse(proxySession('PROXY proxy.fixture:3128; DIRECT') as any, 'https://public.example/', AbortSignal.timeout(1000), vi.fn())).rejects.toThrow('代理')
  expect(state.request).toHaveBeenCalledOnce(); expect(state.agents).toHaveLength(0); expect(state.proxies[0].destroy).toHaveBeenCalledOnce()
})

it('resolves proxy rules and relative redirects against each original destination', async () => {
  const session = proxySession('PROXY proxy.fixture:3128')
  session.resolveProxy.mockResolvedValueOnce('PROXY proxy.fixture:3128').mockResolvedValueOnce('DIRECT')
  state.request.mockResolvedValueOnce({ statusCode: 302, headers: { location: '/next' }, body: { destroy: vi.fn() } })
    .mockResolvedValueOnce({ statusCode: 200, headers: {}, body: 'contents' })
  await withPublicResponse(session as any, 'https://public.example/start', AbortSignal.timeout(1000), response => bodyText(response.body))
  expect(session.resolveProxy.mock.calls).toEqual([['https://public.example/start'], ['https://public.example/next']])
  expect(session.cookies.get.mock.calls).toEqual([[{ url: 'https://public.example/start' }], [{ url: 'https://public.example/next' }]])
  expect(state.request.mock.calls.map(call => call[0].href)).toEqual(['https://8.8.8.8/start', 'https://public.example/next'])
  expect(state.proxies).toHaveLength(1); expect(state.agents).toHaveLength(1)
})

it.each([
  ['session=value; HttpOnly; SameSite=Strict', { path: '/account', httpOnly: true, secure: false, sameSite: 'strict' }],
  ['session=value; Domain=.example.com; Path=/specific; Secure; SameSite=None', { domain: 'example.com', path: '/specific', secure: true, sameSite: 'no_restriction' }],
  ['session=value; Expires=Wed, 01 Jan 2031 00:00:00 GMT', { expirationDate: 1924992000, path: '/account' }],
  ['session=value; Path=invalid', { path: '/account' }],
  ['session=value; Path=/first; Path=invalid', { path: '/account' }],
])('preserves cookie scope and attributes: %s', async (cookie, expected) => {
  const session = { ...proxySession('DIRECT'), cookies: { get: vi.fn(async () => []), set: vi.fn(async (_details: unknown) => {}) } }
  state.request.mockResolvedValue({ statusCode: 200, headers: { 'set-cookie': cookie }, body: 'contents' })
  await withPublicResponse(session as any, 'https://sub.example.com/account/page', AbortSignal.timeout(1000), response => bodyText(response.body))
  expect(session.cookies.set).toHaveBeenCalledOnce()
  expect(session.cookies.set).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://sub.example.com/account/page', name: 'session', value: 'value', ...expected }))
  if (!('domain' in expected)) expect(session.cookies.set.mock.calls[0][0]).not.toHaveProperty('domain')
})

it.each(['Max-Age=0', 'Max-Age=-1', 'Max-Age=600; Max-Age=-1'])('expires cookies for %s even with a later Expires', async attribute => {
  const session = { ...proxySession('DIRECT'), cookies: { get: vi.fn(async () => []), set: vi.fn(async (_details: unknown) => {}) } }
  state.request.mockResolvedValue({ statusCode: 200, headers: { 'set-cookie': `session=value; ${attribute}; Expires=Wed, 01 Jan 2031 00:00:00 GMT` }, body: 'contents' })
  await withPublicResponse(session as any, 'https://public.example/', AbortSignal.timeout(1000), response => bodyText(response.body))
  expect(session.cookies.set).toHaveBeenCalledWith(expect.objectContaining({ expirationDate: 0 }))
})

it('keeps the last Max-Age attribute authoritative after an earlier negative value', async () => {
  const session = { ...proxySession('DIRECT'), cookies: { get: vi.fn(async () => []), set: vi.fn(async (_details: any) => {}) } }
  const before = Date.now() / 1000
  state.request.mockResolvedValue({ statusCode: 200, headers: { 'set-cookie': 'session=value; Max-Age=-1; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT' }, body: 'contents' })
  await withPublicResponse(session as any, 'https://public.example/', AbortSignal.timeout(1000), response => bodyText(response.body))
  expect(session.cookies.set.mock.calls[0][0].expirationDate).toBeGreaterThanOrEqual(before + 59)
})

it.each([
  ['https://public.example/', 'session=value; Domain=other.example'],
  ['https://notexample.com/', 'session=value; Domain=example.com'],
  ['https://sub.example.com/', 'session=value; Domain=..example.com'],
  ['http://public.example/', 'session=value; Secure'],
])('rejects a cookie outside the response origin scope: %s %s', async (url, cookie) => {
  const session = { ...proxySession('DIRECT'), cookies: { get: vi.fn(async () => []), set: vi.fn(async () => {}) } }
  state.request.mockResolvedValue({ statusCode: 200, headers: { 'set-cookie': cookie }, body: 'contents' })
  await withPublicResponse(session as any, url, AbortSignal.timeout(1000), response => bodyText(response.body))
  expect(session.cookies.set).not.toHaveBeenCalled()
})

it('keeps response consumption available when Chromium rejects an individual cookie', async () => {
  const session = { ...proxySession('DIRECT'), cookies: { get: vi.fn(async () => []), set: vi.fn(async () => { throw new Error('Controlled cookie rejection') }) } }
  state.request.mockResolvedValue({ statusCode: 200, headers: { 'set-cookie': ['first=value', 'second=value'] }, body: 'contents' })
  expect(await withPublicResponse(session as any, 'https://public.example/', AbortSignal.timeout(1000), response => bodyText(response.body))).toBe('contents')
  expect(session.cookies.set).toHaveBeenCalledTimes(2)
})
