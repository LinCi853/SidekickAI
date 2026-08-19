// electron/modules/helpers/ipc-helpers.ts — IPC 注册辅助函数
//
// 提供便捷的 IPC 注册方法，内部通过 InjectionBroker 统一管理。
// 用于逐步迁移现有直接 ipcMain.handle/on 调用。

import { ipcMain } from 'electron'
import { injectionBroker } from '../injection-broker.js'
import type { EffectScope } from '../effect-scope.js'
import type { IpcPayload } from '../adapters/types.js'

/**
 * 通过 InjectionBroker 注册 IPC handle（请求-响应模式）。
 * 返回的 EffectHandle 会自动挂到 scope 上。
 */
export async function registerIpcHandle(
  scope: EffectScope,
  channel: string,
  handler: (...args: unknown[]) => unknown,
): Promise<void> {
  await injectionBroker.inject(
    {
      ownerModule: scope.ownerModule,
      capabilityId: `${scope.ownerModule}.ipc.${channel}`,
      kind: 'ipc',
      payload: { channel, handler, mode: 'handle' } as IpcPayload,
    },
    scope,
  )
}

/**
 * 通过 InjectionBroker 注册 IPC on（事件监听模式）。
 * 返回的 EffectHandle 会自动挂到 scope 上。
 */
export async function registerIpcOn(
  scope: EffectScope,
  channel: string,
  listener: (...args: unknown[]) => void,
): Promise<void> {
  await injectionBroker.inject(
    {
      ownerModule: scope.ownerModule,
      capabilityId: `${scope.ownerModule}.ipc.${channel}`,
      kind: 'ipc',
      payload: { channel, listener, mode: 'on' } as IpcPayload,
    },
    scope,
  )
}

/**
 * 批量注册 IPC handle 通道。
 * 用于模块 init 时一次性注册多个通道。
 */
export async function registerIpcHandles(
  scope: EffectScope,
  handlers: Array<{ channel: string; handler: (...args: unknown[]) => unknown }>,
): Promise<void> {
  for (const { channel, handler } of handlers) {
    await registerIpcHandle(scope, channel, handler)
  }
}

/**
 * 批量注册 IPC on 通道。
 */
export async function registerIpcListeners(
  scope: EffectScope,
  listeners: Array<{ channel: string; listener: (...args: unknown[]) => void }>,
): Promise<void> {
  for (const { channel, listener } of listeners) {
    await registerIpcOn(scope, channel, listener)
  }
}
