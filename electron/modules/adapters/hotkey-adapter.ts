// electron/modules/adapters/hotkey-adapter.ts — 热键适配器
//
// 处理全局快捷键的注册和撤销。
// 支持两种模式：globalShortcut 直接注册 / hotkey manager 间接注册。

import { globalShortcut } from 'electron'
import type { TargetAdapter } from './types.js'
import type { HotkeyPayload } from './types.js'
import type { EffectHandle, EffectScope } from '../effect-scope.js'
import type { InjectionRequest } from '../injection-broker.js'
import { getHotkeyManagerInstance } from '../../hotkey/manager.js'

class HotkeyAdapterImpl implements TargetAdapter {
  readonly kind = 'hotkey' as const

  async apply(request: InjectionRequest, scope: EffectScope): Promise<EffectHandle> {
    const payload = request.payload as HotkeyPayload
    const { accelerator, callback, useManager, actionName } = payload

    if (useManager && actionName) {
      // 使用 hotkey manager 注册
      const hm = getHotkeyManagerInstance()
      if (!hm) {
        throw new Error('[hotkey-adapter] HotkeyManager 未初始化')
      }
      await hm.register(accelerator, callback)

      return scope.create('hotkey', request.capabilityId, () => {
        hm.unregister(accelerator)
      }, request.target?.id)
    } else {
      // 使用 globalShortcut 直接注册
      const registered = globalShortcut.register(accelerator, callback)
      if (!registered) {
        throw new Error(`[hotkey-adapter] 快捷键注册失败: ${accelerator}`)
      }

      return scope.create('hotkey', request.capabilityId, () => {
        globalShortcut.unregister(accelerator)
      }, request.target?.id)
    }
  }
}

export const hotkeyAdapter = new HotkeyAdapterImpl()
