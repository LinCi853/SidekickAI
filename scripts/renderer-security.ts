import type { Plugin } from 'vite'
import { rendererContentSecurityPolicy } from '../electron/shared/renderer-csp.mjs'

const refreshPath = '/@sidekick/refresh-preamble.js'

export function rendererSecurity(): Plugin {
  let refreshPreamble = ''
  return {
    name: 'renderer-security',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== refreshPath || !refreshPreamble) { next(); return }
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8')
        response.setHeader('Cache-Control', 'no-store')
        response.end(refreshPreamble)
      })
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        if (!context.server) return html
        const addresses = context.server.resolvedUrls?.local ?? []
        const policy = rendererContentSecurityPolicy(addresses)
        return html.replace(/(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]+(")/i, `$1${policy}$2`)
          .replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (element, attributes: string, content: string) => {
            if (!/\btype=["']module["']/i.test(attributes) || /\bsrc=/i.test(attributes) || !content.includes('/@react-refresh')) return element
            refreshPreamble = content
            return `<script type="module" src="${refreshPath}"></script>`
          })
      },
    },
  }
}
