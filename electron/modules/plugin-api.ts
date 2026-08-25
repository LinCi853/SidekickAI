// electron/modules/plugin-api.ts — 插件 API 合约
//
// 定义插件可用的稳定接口。第一方可直接 import 内部模块（同一代码库），
// 但 PluginContext 作为文档化的边界，为未来第三方插件做准备。
// 设计规范见 docs/功能插件系统与安装管控方案.md。

import { ipcMain } from 'electron'
import { resolveSqlitePath } from '../store/store-paths.js'
import type { CapabilityRef } from '../shared/module-manifest.types.js'
import type { EffectHandle } from './effect-scope.js'
import { EffectScope } from './effect-scope.js'
import { injectionBroker, type InjectionRequest } from './injection-broker.js'
import { capabilityRegistry } from './capability-registry.js'
import { featureGate } from './feature-gate.js'
import { targetRegistry } from './target-registry.js'

/** 插件上下文 — 在 init 时提供给插件，封装内部 API 为稳定接口 */
export interface PluginContext {
  /** 本插件的模块 id */
  readonly moduleId: string
  /** 副作用管理 scope（init 注册的副作用会在 teardown 时自动清理） */
  readonly scope: EffectScope

  /** 注册 IPC handler（自动追踪到 scope） */
  ipcHandle(channel: string, handler: (...args: any[]) => any): void
  /** 注册 IPC listener（自动追踪到 scope） */
  ipcOn(channel: string, listener: (...args: any[]) => void): void

  /** 通过 InjectionBroker 统一注入（自动填充 ownerModule） */
  inject(request: Omit<InjectionRequest, 'ownerModule'>): Promise<EffectHandle>

  /** 解析 SQLite 文件路径（自动处理 dev/便携/安装模式） */
  resolveDbPath(filename: string): string

  /** 运行时注册能力声明 */
  registerCapability(cap: CapabilityRef): void

  /** 查询能力是否可用 */
  isCapabilityAvailable(capabilityId: string): boolean
  /** 查询权限 */
  hasPermission(capabilityId: string): boolean
}

/**
 * 为指定模块创建 PluginContext。
 * 由注册表在 init 流程中调用，或插件自行构造。
 */
export function createPluginContext(moduleId: string): PluginContext {
  const scope = new EffectScope(moduleId, moduleId)

  return {
    moduleId,
    scope,

    ipcHandle(channel, handler) {
      scope.ipcHandle(channel, handler)
    },

    ipcOn(channel, listener) {
      scope.ipcOn(channel, listener)
    },

    async inject(request) {
      return injectionBroker.inject(
        { ...request, ownerModule: moduleId },
        scope,
      )
    },

    resolveDbPath(filename) {
      return resolveSqlitePath(filename)
    },

    registerCapability(cap) {
      capabilityRegistry.register(cap)
    },

    isCapabilityAvailable(capId) {
      return featureGate.isCapabilityAvailable(capId)
    },

    hasPermission(capId) {
      return featureGate.hasPermission(capId, moduleId)
    },
  }
}
