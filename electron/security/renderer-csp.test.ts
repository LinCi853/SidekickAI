import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'

const state = vi.hoisted(() => ({ app: { isPackaged: true } }))
vi.mock('electron', () => ({ app: state.app, BrowserWindow: {} }))
vi.mock('../window-factory/paths.js', () => ({ __dirname: 'E:/fixture/app/main' }))
import { installRendererContentSecurity } from './renderer-csp.js'
import { RENDERER_CONTENT_SECURITY_POLICY, rendererContentSecurityPolicy } from '../shared/renderer-csp.mjs'

const documentUrl = pathToFileURL(path.resolve('E:/fixture/app/renderer/index.html')).href
function fixture() {
  const onHeadersReceived = vi.fn(); installRendererContentSecurity({ webRequest: { onHeadersReceived } } as unknown as Session)
  return (url: string, responseHeaders: Record<string, string[]> = {}) => {
    const callback = vi.fn(); onHeadersReceived.mock.calls[0][0]({ url, responseHeaders }, callback)
    return callback.mock.calls[0][0]
  }
}
beforeEach(() => { state.app.isPackaged = true; vi.stubEnv('ELECTRON_RENDERER_URL', '') })
afterEach(() => vi.unstubAllEnvs())

describe('application document security policy', () => {
  it('replaces the response policy only on the exact application document', () => {
    const respond = fixture()
    const result = respond(`${documentUrl}?mode=settings`, { 'content-security-policy': ["script-src * 'unsafe-inline'"], 'Content-Type': ['text/html'], ETag: ['fixture'] })
    expect(result.responseHeaders).toEqual({ 'Content-Type': ['text/html'], ETag: ['fixture'], 'Content-Security-Policy': [RENDERER_CONTENT_SECURITY_POLICY + "; frame-ancestors 'none'"] })
    for (const url of [documentUrl.replace('index.html', 'other.html'), 'https://external.test/index.html', `${documentUrl}/other`]) expect(respond(url)).toEqual({})
  })

  it('allows the exact development WebSocket without opening packaged network authority', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173/'); state.app.isPackaged = false
    const response = fixture()('http://localhost:5173/?mode=settings')
    expect(response.responseHeaders['Content-Security-Policy'][0]).toContain('ws://localhost:5173')
    expect(fixture()('http://localhost:5174/')).toEqual({})
    expect(fixture()('http://localhost:5173/other.html')).toEqual({})
    state.app.isPackaged = true
    expect(fixture()(documentUrl).responseHeaders['Content-Security-Policy'][0]).not.toContain('ws:')
    expect(fixture()('http://localhost:5173/')).toEqual({})
  })

  it('keeps the file-document fallback identical and limits development sources to safe origins', () => {
    const html = readFileSync(new URL('../../src/index.html', import.meta.url), 'utf8')
    expect(html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1]).toBe(RENDERER_CONTENT_SECURITY_POLICY)
    const policy = rendererContentSecurityPolicy(['https://dev.test:5173/app', 'https://dev.test:5173/', 'file:///private', 'http://user:pass@other.test/', 'invalid'])
    expect(policy).toBe(`${RENDERER_CONTENT_SECURITY_POLICY} wss://dev.test:5173`)
    expect(policy.match(/script-src ([^;]+)/)?.[1]).toBe("'self'")
  })
})

describe('synchronous theme startup', () => {
  const script = readFileSync(new URL('../../src/public/theme-startup.js', import.meta.url), 'utf8')
  function run(values: Record<string, string>, dark = false, height = 1080) {
    const attributes: Record<string, string> = {}, styles: Record<string, string> = {}, classes = new Set<string>()
    const html = { setAttribute: (key: string, value: string) => { attributes[key] = value }, style: { setProperty: (key: string, value: string) => { styles[key] = value } },
      classList: { remove: (name: string) => classes.delete(name), toggle: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name) } }
    runInNewContext(script, { document: { documentElement: html }, localStorage: { getItem: (key: string) => values[key] ?? null }, window: { screen: { height }, matchMedia: () => ({ matches: dark }) } })
    return { attributes, styles, classes }
  }

  it.each(['dark', 'light', 'system'])('restores classic %s before page rendering', preference => {
    const result = run({ 'sidekick-ui-version': 'classic', 'ai-window-theme': preference, 'sidekick-user-ui-scale': 'large' }, true)
    const dark = preference !== 'light'
    expect(result.attributes).toEqual({ 'data-ui-version': 'classic', 'data-theme': dark ? 'dark' : 'light', 'data-ui-scale': 'large' })
    expect(result.classes.has('dark')).toBe(dark)
  })

  it.each([[1080, 'compact'], [1440, 'standard'], [2160, 'spacious']] as const)('restores Oxy color and scale at %s', (height, scale) => {
    const result = run({ 'sidekick-active-app-color': '#a34031' }, false, height)
    expect(result.attributes).toEqual({ 'data-ui-version': 'oxy', 'data-theme': 'light', 'data-oxy': 'true', 'data-oxy-scale': scale })
    expect(result.styles).toEqual({ '--primary': '#a34031', '--brand-500': '#a34031' })
  })
})
