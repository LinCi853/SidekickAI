// electron/modules/plugins/prompt-library/injection-ipc.ts — 注入历史 IPC 注册
//
// 提示词库模块专属：记录提示词注入、近期列表、Jaccard 相似度去重与清空。
//
// 已迁移到统一注入管线：支持 EffectScope 管理 IPC handler 生命周期。

import { ipcMain } from 'electron'
import type { EffectScope } from '../../effect-scope.js'
import { IPC_CHANNELS } from '../../../shared/types.js'
import { injectionHistoryStore } from './injection-history-store.js'

/**
 * 注册注入历史 IPC（提示词库模块：预览 + Jaccard 去重）。
 *
 * 已迁移到统一注入管线：支持 EffectScope 管理 IPC handler 生命周期。
 */
export function registerInjectionIpc(scope?: EffectScope): void {
  const ipc = IPC_CHANNELS

  // 辅助函数：根据是否有 scope 选择注册方式
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = scope
    ? (channel: string, fn: (...args: any[]) => any) => scope.ipcHandle(channel, fn as any)
    : (channel: string, fn: (...args: any[]) => any) => ipcMain.handle(channel, fn as any)

  handle(ipc.INJECTION_LOG, (_e: unknown, record: any) => {
    return injectionHistoryStore.log(record)
  })
  handle(ipc.INJECTION_LIST_RECENT, (_e: unknown, limit?: number) => {
    return injectionHistoryStore.listRecent(limit)
  })
  handle(
    ipc.INJECTION_FIND_SIMILAR,
    (_e: unknown, text: string, limit?: number, threshold?: number) => {
      return injectionHistoryStore.findSimilar(text, limit, threshold)
    },
  )
  handle(ipc.INJECTION_CLEAR, () => {
    return injectionHistoryStore.clear()
  })
}
