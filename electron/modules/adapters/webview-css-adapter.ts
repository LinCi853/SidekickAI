// electron/modules/adapters/webview-css-adapter.ts — webview CSS 注入适配器
//
// 处理 insertCSS 注入。
// CSS 注入可以通过 removeInsertedCSS 撤销（Electron 支持）。

import type { TargetAdapter } from './types.js'
import type { WebviewCssPayload } from './types.js'
import type { EffectHandle, EffectScope } from '../effect-scope.js'
import type { InjectionRequest } from '../injection-broker.js'

class WebviewCssAdapterImpl implements TargetAdapter {
  readonly kind = 'webview-css' as const

  async apply(request: InjectionRequest, scope: EffectScope): Promise<EffectHandle> {
    const payload = request.payload as WebviewCssPayload
    const { webContents, css, reinjectOnNavigation } = payload

    if (webContents.isDestroyed()) {
      throw new Error('[webview-css-adapter] webContents 已销毁')
    }

    const targetId = request.target?.id ?? `wc-${webContents.id}`
    let disposed = false
    let currentKey: string | null = null
    let navHandler: (() => void) | null = null

    // 执行 CSS 注入
    const doInject = async () => {
      if (disposed || webContents.isDestroyed()) return
      try {
        // 先移除旧的
        if (currentKey !== null) {
          try {
            await webContents.removeInsertedCSS(currentKey)
          } catch {
            // 忽略：页面导航后旧 key 自动失效
          }
        }
        currentKey = await webContents.insertCSS(css)
      } catch (err) {
        if (!disposed) {
          console.warn(`[webview-css-adapter] CSS 注入失败 (${targetId}):`, err)
        }
      }
    }

    // 首次注入
    await doInject()

    // 导航后重新注入
    if (reinjectOnNavigation && !disposed) {
      navHandler = () => {
        currentKey = null // 页面导航后旧 key 失效
        void doInject()
      }
      webContents.on('did-finish-load', navHandler)
    }

    return scope.create('webview-css', request.capabilityId, () => {
      disposed = true
      if (navHandler && !webContents.isDestroyed()) {
        webContents.removeListener('did-finish-load', navHandler)
      }
      // 移除已注入的 CSS
      if (currentKey !== null && !webContents.isDestroyed()) {
        webContents.removeInsertedCSS(currentKey).catch(() => {
          // 忽略清理失败
        })
        currentKey = null
      }
    }, targetId)
  }
}

export const webviewCssAdapter = new WebviewCssAdapterImpl()
