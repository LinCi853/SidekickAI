// electron/modules/adapters/ipc-adapter.ts — IPC 适配器
//
// 处理 ipcMain.handle / ipcMain.on 的注册和撤销。
// 内部委托 EffectScope 的 IPC 方法，保持与现有 IpcScope 行为一致。

import { ipcMain } from 'electron'
import type { TargetAdapter } from './types.js'
import type { IpcPayload } from './types.js'
import type { EffectHandle, EffectScope } from '../effect-scope.js'
import type { InjectionRequest } from '../injection-broker.js'

class IpcAdapterImpl implements TargetAdapter {
  readonly kind = 'ipc' as const

  async apply(request: InjectionRequest, scope: EffectScope): Promise<EffectHandle> {
    const payload = request.payload as IpcPayload
    const { channel, handler, listener, mode } = payload

    if (mode === 'handle' && handler) {
      ipcMain.handle(channel, handler as (...args: unknown[]) => unknown)
    } else if (mode === 'on' && listener) {
      ipcMain.on(channel, listener as (...args: unknown[]) => void)
    } else {
      throw new Error(`[ipc-adapter] 无效的 IPC 注入: mode=${mode}`)
    }

    return scope.create('ipc', request.capabilityId, () => {
      ipcMain.removeHandler(channel)
      ipcMain.removeAllListeners(channel)
    }, request.target?.id)
  }
}

export const ipcAdapter = new IpcAdapterImpl()
