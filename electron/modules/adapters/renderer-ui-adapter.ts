// electron/modules/adapters/renderer-ui-adapter.ts — 渲染层 UI 适配器
//
// 处理渲染层 UI 组件的注册和注销。
// 通过 webContents.send 向渲染层发送注册/注销消息。

import type { TargetAdapter } from './types.js'
import type { RendererUiPayload } from './types.js'
import type { EffectHandle, EffectScope } from '../effect-scope.js'
import type { InjectionRequest } from '../injection-broker.js'

class RendererUiAdapterImpl implements TargetAdapter {
  readonly kind = 'renderer-ui' as const

  async apply(request: InjectionRequest, scope: EffectScope): Promise<EffectHandle> {
    const payload = request.payload as RendererUiPayload
    const { componentId, webContents, registerMessage, unregisterMessage } = payload

    const targetId = request.target?.id ?? `wc-${webContents.id}`

    if (webContents.isDestroyed()) {
      throw new Error('[renderer-ui-adapter] webContents 已销毁')
    }

    // 发送注册消息
    webContents.send(registerMessage.channel, registerMessage.data)

    return scope.create('renderer-ui', request.capabilityId, () => {
      if (webContents.isDestroyed()) return
      // 发送注销消息
      if (unregisterMessage) {
        try {
          webContents.send(unregisterMessage.channel, unregisterMessage.data)
        } catch (err) {
          console.warn(`[renderer-ui-adapter] 注销 ${componentId} 失败:`, err)
        }
      }
    }, targetId)
  }
}

export const rendererUiAdapter = new RendererUiAdapterImpl()
