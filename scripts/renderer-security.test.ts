import { describe, expect, it, vi } from 'vitest'
import { rendererSecurity } from './renderer-security'
import { RENDERER_CONTENT_SECURITY_POLICY } from '../electron/shared/renderer-csp.mjs'

function fixture() {
  const plugin = rendererSecurity(), use = vi.fn()
  const server = { middlewares: { use }, resolvedUrls: { local: ['http://localhost:5173/'] } }
  ;(plugin.configureServer as Function)(server)
  const hook = plugin.transformIndexHtml as { handler: (html: string, context: any) => string }
  return { transform: (html: string, development = true) => hook.handler(html, development ? { server } : {}), serve: use.mock.calls[0][0] }
}
const meta = `<meta http-equiv="Content-Security-Policy" content="${RENDERER_CONTENT_SECURITY_POLICY}" />`

describe('development renderer script policy', () => {
  it('serves the React refresh preamble as a same-origin external module', () => {
    const test = fixture(), preamble = 'import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window);'
    const html = test.transform(`${meta}<script type="module">${preamble}</script><script type="module" src="/src/main.tsx"></script>`)
    expect(html).toContain('<script type="module" src="/@sidekick/refresh-preamble.js"></script>')
    expect(html).not.toContain(preamble); expect(html).toContain("script-src 'self'")
    expect(html).toContain('ws://localhost:5173'); expect(html).not.toContain("script-src 'self' 'unsafe-inline'")
    const response = { setHeader: vi.fn(), end: vi.fn() }, next = vi.fn()
    test.serve({ url: '/@sidekick/refresh-preamble.js?t=1' }, response, next)
    expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'text/javascript; charset=utf-8')
    expect(response.end).toHaveBeenCalledWith(preamble); expect(next).not.toHaveBeenCalled()
    test.serve({ url: '/other.js' }, response, next); expect(next).toHaveBeenCalledOnce()
  })

  it('keeps production HTML unchanged and does not authorize unrelated inline scripts', () => {
    const test = fixture(), html = `${meta}<script>window.untrusted = true</script>`
    expect(test.transform(html, false)).toBe(html)
    expect(test.transform(html)).toContain('<script>window.untrusted = true</script>')
    const response = { end: vi.fn() }, next = vi.fn(); test.serve({ url: '/@sidekick/refresh-preamble.js' }, response, next)
    expect(next).toHaveBeenCalledOnce(); expect(response.end).not.toHaveBeenCalled()
  })
})
