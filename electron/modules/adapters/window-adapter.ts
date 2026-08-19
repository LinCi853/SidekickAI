// electron/modules/adapters/window-adapter.ts — 窗口适配器
//
// 处理 BrowserWindow 的生命周期管理。
// 窗口销毁时自动清理句柄。

import type { TargetAdapter } from './types.js'
import type { WindowPayload } from './types.js'
import type { EffectHandle, EffectScope } from '../effect-scope.js'
import type { InjectionRequest } from '../injection-broker.js'

class WindowAdapterImpl implements TargetAdapter {
  readonly kind = 'window' as const

  async apply(request: InjectionRequest, scope: EffectScope): Promise<EffectHandle> {
    const payload = request.payload as WindowPayload
    const { window, label } = payload

    const windowId = `window-${window.id}`

    // 监听窗口销毁，自动清理
    const onDestroyed = () => {
      // 句柄的 dispose 会被 EffectScope 统一调用，这里仅做日志
      console.log(`[window-adapter] 窗口已销毁: ${label ?? windowId}`)
    }
    window.once('closed', onDestroyed)

    return scope.create('window', request.capabilityId, () => {
      window.removeListener('closed', onDestroyed)
      if (!window.isDestroyed()) {
        try {
          window.close()
        } catch (err) {
          console.warn(`[window-adapter] 关闭窗口失败: ${label ?? windowId}`, err)
        }
      }
    }, windowId)
  }
}

export const windowAdapter = new WindowAdapterImpl()
