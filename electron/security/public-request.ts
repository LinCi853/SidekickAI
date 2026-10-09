import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import { Agent, ProxyAgent, fetch, Headers, getSetCookies, type Response } from 'undici'
import type { Session } from 'electron'

export interface PublicResponse {
  statusCode: number
  headers: Record<string, string>
  body: AsyncIterable<Uint8Array>
}

export function httpUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 16384) throw new Error('网页地址无效。')
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('仅支持不含登录凭据的 HTTP 或 HTTPS 网页链接。')
  return url
}

/** Only globally routable destinations can receive privileged application requests. */
export function isPublicAddress(value: string): boolean {
  const family = isIP(value)
  if (family === 4) {
    const [a, b, c] = value.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99)
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113)
  }
  if (family === 6) {
    const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1)
    const [first, second = '0'] = normalized.split(':')
    const a = parseInt(first, 16), b = parseInt(second || '0', 16)
    return a >= 0x2000 && a <= 0x3fff && !(a === 0x2001 && (b < 0x200 || b === 0xdb8))
      && a !== 0x2002 && !(a === 0x3fff && b <= 0xfff)
  }
  return false
}

export async function publicDestination(value: unknown): Promise<{ url: URL; address: string; family: number }> {
  const url = httpUrl(value)
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true })
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error('此请求只允许访问公网地址。')
  return { url, ...addresses[0] }
}

function proxyEndpoint(resolution: string): URL | null {
  const primary = resolution.split(';')[0].trim()
  if (primary.toUpperCase() === 'DIRECT') return null
  const match = /^(PROXY|HTTPS)\s+(\S+)$/i.exec(primary)
  if (!match) throw new Error('当前会话的代理类型暂不支持此操作，请使用 HTTP 或 HTTPS 代理。')
  try {
    const proxy = new URL(`${match[1].toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${match[2]}`)
    if (!proxy.hostname || proxy.username || proxy.password || proxy.pathname !== '/' || proxy.search || proxy.hash) throw new Error('Invalid proxy address')
    return proxy
  } catch { throw new Error('当前会话的代理地址无效，请检查代理设置。') }
}

function credentialsForProxy(config: { proxyMode?: string; customProxy?: string; proxyUsername?: string; proxyPassword?: string }, proxy: URL): string | undefined {
  if (config.proxyMode !== 'custom' || !(config.proxyUsername || config.proxyPassword)) return undefined
  const address = (config.customProxy || '').trim()
  try {
    const configured = new URL(address.includes('://') ? address : `http://${address}`)
    if (configured.origin !== proxy.origin || configured.username || configured.password
      || configured.pathname !== '/' || configured.search || configured.hash) return undefined
  } catch { return undefined }
  return `Basic ${Buffer.from(`${config.proxyUsername || ''}:${config.proxyPassword || ''}`).toString('base64')}`
}

async function proxyAuthorization(session: Session, proxy: URL): Promise<string | undefined> {
  const profileId = (session as Session & { __profileId?: string }).__profileId
  if (profileId) {
    const { readProfile } = await import('../store/profile-repository.js')
    const profile = readProfile(profileId)
    if (profile?.proxyConfig) return credentialsForProxy(profile.proxyConfig, proxy)
    if (profile?.proxy?.trim()) return undefined
  }
  const { readSettingsRaw } = await import('../store/app-settings-repository.js')
  return credentialsForProxy(readSettingsRaw(), proxy)
}

async function storeResponseCookies(session: Session, url: URL, headers: Headers, signal: AbortSignal): Promise<void> {
  const defaultPath = url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/'
  const normalized = new Headers()
  for (const value of headers.getSetCookie()) {
    normalized.append('set-cookie', value
      .replace(/(;\s*max-age\s*=\s*)-\d+(?=\s*(?:;|$))/gi, (_match, prefix: string) => `${prefix}0`)
      .replace(/(;\s*path\s*=\s*)([^;]*)/gi, (_match, prefix: string, path: string) => `${prefix}${path.trim().startsWith('/') ? path.trim() : defaultPath}`))
  }
  const hostname = url.hostname.toLowerCase()
  for (const cookie of getSetCookies(normalized)) {
    signal.throwIfAborted()
    if (!cookie || cookie.secure && url.protocol !== 'https:') continue
    const domain = cookie.domain?.toLowerCase()
    if (domain && domain !== hostname && (isIP(hostname) || !hostname.endsWith(`.${domain}`))) continue
    const expires = cookie.expires instanceof Date ? cookie.expires.getTime() / 1000 : cookie.expires
    const expirationDate = typeof cookie.maxAge === 'number'
      ? cookie.maxAge <= 0 ? 0 : Date.now() / 1000 + Math.min(cookie.maxAge, 400 * 24 * 60 * 60)
      : expires
    try {
      await session.cookies.set({ url: url.href, name: cookie.name, value: cookie.value,
        ...(domain ? { domain } : {}), path: cookie.path?.startsWith('/') ? cookie.path : defaultPath,
        secure: !!cookie.secure, httpOnly: !!cookie.httpOnly,
        sameSite: cookie.sameSite === 'None' ? 'no_restriction' : cookie.sameSite === 'Lax' ? 'lax' : cookie.sameSite === 'Strict' ? 'strict' : 'unspecified',
        ...(typeof expirationDate === 'number' && Number.isFinite(expirationDate) ? { expirationDate } : {}) })
    } catch { }
  }
}

/** The connection uses the checked address; redirects receive a new check and their own cookies. */
export async function withPublicResponse<T>(
  session: Session, value: unknown, signal: AbortSignal,
  consume: (response: PublicResponse) => Promise<T>,
): Promise<T> {
  let current = value
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted()
    const destination = await publicDestination(current)
    const proxy = proxyEndpoint(await session.resolveProxy(destination.url.href).catch(error => {
      if (!signal.aborted) throw new Error('代理解析失败，请检查当前会话的代理设置。', { cause: error })
      throw error
    }))
    signal.throwIfAborted()
    const requestUrl = new URL(destination.url)
    const hostname = destination.url.hostname.replace(/^\[|\]$/g, '')
    if (proxy) requestUrl.hostname = destination.family === 6 ? `[${destination.address}]` : destination.address
    const dispatcher = proxy ? new ProxyAgent({ uri: proxy.href, token: await proxyAuthorization(session, proxy),
      requestTls: { servername: isIP(hostname) ? undefined : hostname } }) : new Agent({ connect: { lookup: (_hostname, options, callback) => {
      if (options.all) callback(null, [{ address: destination.address, family: destination.family }])
      else callback(null, destination.address, destination.family)
    } } })
    const transport = proxy ? dispatcher.compose(dispatch => (options, handler) => dispatch({ ...options,
      headers: Array.isArray(options.headers) ? [...options.headers, 'host', destination.url.host]
        : { ...options.headers, host: destination.url.host },
    }, handler)) : dispatcher
    let responseBody: Response['body'] | undefined
    let body: Readable | undefined
    try {
      signal.throwIfAborted()
      const cookies = await session.cookies.get({ url: destination.url.href })
      const response = await fetch(requestUrl, { dispatcher: transport, signal, redirect: 'manual',
        headers: { host: destination.url.host, 'user-agent': session.getUserAgent(),
          ...(cookies.length ? { cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') } : {}) } })
        .catch(error => {
          if (proxy && !signal.aborted) throw new Error('代理连接失败，请检查当前会话的代理设置。', { cause: error })
          throw error
        })
      responseBody = response.body
      await storeResponseCookies(session, destination.url, response.headers, signal)
      signal.throwIfAborted()
      const location = response.headers.get('location')
      if ([301, 302, 303, 307, 308].includes(response.status) && location !== null) {
        current = new URL(location, destination.url).href
        continue
      }
      body = responseBody ? Readable.fromWeb(responseBody) : Readable.from([])
      const headers: Record<string, string> = {}
      response.headers.forEach((value, name) => { headers[name] = value })
      return await consume({ statusCode: response.status, headers, body })
    } finally {
      if (body) body.destroy()
      else if (responseBody && !responseBody.locked) await responseBody.cancel().catch(() => {})
      await dispatcher.destroy()
    }
  }
  throw new Error('网页重定向次数过多。')
}
