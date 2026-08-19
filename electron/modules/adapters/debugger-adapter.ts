// electron/modules/adapters/debugger-adapter.ts — Debugger 适配器
//
// 处理 CDP Debugger session 的 attach/detach。
// 用于 freeze 模块的页面冻结场景。
// 撤销时自动 resume + detach。

import type { TargetAdapter } from './types.js'
import type { DebuggerPayload } from './types.js'
import type { EffectHandle, EffectScope } from '../effect-scope.js'
import type { InjectionRequest } from '../injection-broker.js'

class DebuggerAdapterImpl implements TargetAdapter {
  readonly kind = 'debugger' as const

  async apply(request: InjectionRequest, scope: EffectScope): Promise<EffectHandle> {
    const payload = request.payload as DebuggerPayload
    const { webContents, protocolVersion, pauseAfterAttach } = payload

    if (webContents.isDestroyed()) {
      throw new Error('[debugger-adapter] webContents 已销毁')
    }

    const targetId = request.target?.id ?? `wc-${webContents.id}`

    // attach
    if (!webContents.debugger.isAttached()) {
      await webContents.debugger.attach(protocolVersion ?? '1.3')
    }

    // 可选：attach 后立即 pause
    if (pauseAfterAttach) {
      await webContents.debugger.sendCommand('Debugger.pause')
    }

    return scope.create('debugger', request.capabilityId, async () => {
      if (webContents.isDestroyed()) return
      try {
        // resume（如果已 pause）
        if (webContents.debugger.isAttached()) {
          await webContents.debugger.sendCommand('Debugger.resume').catch(() => {
            // 可能未 pause，忽略
          })
          await webContents.debugger.detach()
        }
      } catch (err) {
        console.warn(`[debugger-adapter] detach 失败 (${targetId}):`, err)
      }
    }, targetId)
  }
}

export const debuggerAdapter = new DebuggerAdapterImpl()
