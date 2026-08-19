// electron/modules/adapters/webview-script-adapter.ts — webview 脚本注入适配器
//
// 处理 executeJavaScript 注入。
// 关键约束：页面导航会销毁 JS 上下文，旧脚本句柄失效。
// 因此支持 reinjectOnNavigation 模式：导航后自动重新注入。

import type { TargetAdapter } from './types.js'
import type { WebviewScriptPayload } from './types.js'
import type { EffectHandle, EffectScope } from '../effect-scope.js'
import type { InjectionRequest } from '../injection-broker.js'

class WebviewScriptAdapterImpl implements TargetAdapter {
  readonly kind = 'webview-script' as const

  async apply(request: InjectionRequest, scope: EffectScope): Promise<EffectHandle> {
    const payload = request.payload as WebviewScriptPayload
    const { webContents, script, reinjectOnNavigation } = payload

    if (webContents.isDestroyed()) {
      throw new Error('[webview-script-adapter] webContents 已销毁')
    }

    const targetId = request.target?.id ?? `wc-${webContents.id}`
    let disposed = false
    let navHandler: (() => void) | null = null

    // 执行注入
    const doInject = async () => {
      if (disposed || webContents.isDestroyed()) return
      try {
        await webContents.executeJavaScript(script)
      } catch (err) {
        if (!disposed) {
          console.warn(`[webview-script-adapter] 脚本注入失败 (${targetId}):`, err)
        }
      }
    }

    // 首次注入
    await doInject()

    // 导航后重新注入
    if (reinjectOnNavigation && !disposed) {
      navHandler = () => {
        void doInject()
      }
      webContents.on('did-finish-load', navHandler)
    }

    return scope.create('webview-script', request.capabilityId, () => {
      disposed = true
      if (navHandler && !webContents.isDestroyed()) {
        webContents.removeListener('did-finish-load', navHandler)
      }
      // 脚本注入不可撤销（JS 已执行），只能停止后续重新注入
    }, targetId)
  }
}

export const webviewScriptAdapter = new WebviewScriptAdapterImpl()
