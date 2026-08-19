// electron/ipc/module-ipc.ts — 模块管理 IPC 注册
//
// MODULE_LIST / MODULE_SET_ENABLED / MODULE_CLEAR_DATA。
// 注册时机：app.whenReady 后由 main.ts 调用 registerModuleIpc()。
// 注意：本文件只注册模块管理自身的通道；各模块自己的 IPC 由各自 init 注册。
//
// 已迁移到统一注入管线：支持 EffectScope 管理 IPC handler 生命周期。

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../shared/types.js'
import {
  clearModuleData,
  listModuleInfos,
  runResidualScan,
  setModuleEnabled,
} from '../modules/registry.js'
import type { EffectScope } from '../modules/effect-scope.js'

/**
 * 注册模块管理 IPC handler。
 *
 * 已迁移到统一注入管线：支持 EffectScope 管理 IPC handler 生命周期。
 */
export function registerModuleIpc(scope?: EffectScope): void {
  // 辅助函数：根据是否有 scope 选择注册方式
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = scope
    ? (channel: string, fn: (...args: any[]) => any) => scope.ipcHandle(channel, fn as any)
    : (channel: string, fn: (...args: any[]) => any) => ipcMain.handle(channel, fn as any)

  handle(IPC_CHANNELS.MODULE_LIST, () => listModuleInfos())

  handle(
    IPC_CHANNELS.MODULE_SET_ENABLED,
    async (_e: unknown, payload: { id: string; enabled: boolean }) => {
      if (!payload || typeof payload.id !== 'string' || typeof payload.enabled !== 'boolean') {
        return { ok: false, error: '参数错误' }
      }
      return setModuleEnabled(payload.id, payload.enabled)
    },
  )

  handle(IPC_CHANNELS.MODULE_CLEAR_DATA, async (_e: unknown, payload: { id: string }) => {
    if (!payload || typeof payload.id !== 'string') {
      return { ok: false, error: '参数错误' }
    }
    return clearModuleData(payload.id)
  })

  // 零残留诊断扫描（11.8/11.10 验收门禁用）
  handle(IPC_CHANNELS.MODULE_DIAGNOSTICS, () => runResidualScan())
}
