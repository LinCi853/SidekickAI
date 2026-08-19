// electron/modules/feature-gate.ts — 全局功能开关策略
//
// 统一入口：模块状态 + 能力可用性检查 + 权限校验。
// 渲染层的 isEnabled() 是体验层控制（隐藏 UI），FeatureGate 才是真正的安全边界。
//
// 设计：FeatureGate 是 registry.ts 的薄包装，增加能力级门控和权限校验。
// 不替换 registry.ts 的 API，而是在其之上增加一层。
//
// Phase 7：增加插件权限校验基础设施。

import {
  isModuleEnabled as registryIsModuleEnabled,
  isModuleInstalled as registryIsModuleInstalled,
  assertModuleEnabled as registryAssertModuleEnabled,
} from './registry.js'
import { capabilityRegistry } from './capability-registry.js'

// ==================== 权限类型 ====================

/** 权限级别 */
export type PermissionLevel = 'allow' | 'deny' | 'ask'

/** 权限规则 */
export interface PermissionRule {
  /** 权限标签（与 Capability.permission 对应） */
  permission: string
  /** 权限级别 */
  level: PermissionLevel
  /** 适用的插件 id 列表（空 = 所有插件） */
  pluginIds?: string[]
  /** 适用的能力 id 列表（空 = 所有能力） */
  capabilityIds?: string[]
  /** 人类可读描述 */
  description?: string
}

/** 权限查询上下文 */
export interface PermissionContext {
  /** 请求权限的插件/模块 id */
  requesterId: string
  /** 请求的能力 id */
  capabilityId: string
  /** 请求的权限标签 */
  permission: string
  /** 目标（可选） */
  target?: { type: string; id: string }
}

class FeatureGateImpl {
  // ==================== 权限规则存储 ====================
  /** permission → PermissionRule[] */
  private readonly permissionRules = new Map<string, PermissionRule[]>()
  /** 插件权限白名单：pluginId → Set<permission> */
  private readonly pluginPermissions = new Map<string, Set<string>>()

  // ==================== 模块级门控（委托 registry） ====================

  /** 模块是否启用 */
  isModuleEnabled(moduleId: string): boolean {
    return registryIsModuleEnabled(moduleId)
  }

  /** 模块是否已安装 */
  isModuleInstalled(moduleId: string): boolean {
    return registryIsModuleInstalled(moduleId)
  }

  /** 断言模块已启用，否则抛错 */
  assertModuleEnabled(moduleId: string, actionLabel?: string): void {
    registryAssertModuleEnabled(moduleId, actionLabel)
  }

  // ==================== 能力级门控 ====================

  /**
   * 能力是否可用：
   * 1. 能力已注册
   * 2. 所属模块已启用
   * 3. 依赖的模块/能力全部可用
   */
  isCapabilityAvailable(capabilityId: string): boolean {
    const cap = capabilityRegistry.get(capabilityId)
    if (!cap) return false

    // 所属模块必须启用
    if (!this.isModuleEnabled(cap.ownerModule)) return false

    // 依赖检查
    if (cap.dependencies) {
      for (const dep of cap.dependencies) {
        // 依赖可能是模块 id 或 capability id
        if (!this.isModuleEnabled(dep) && !this.isCapabilityAvailable(dep)) {
          return false
        }
      }
    }

    return true
  }

  /** 断言能力可用，否则抛错 */
  assertCapability(capabilityId: string): void {
    if (!this.isCapabilityAvailable(capabilityId)) {
      const cap = capabilityRegistry.get(capabilityId)
      const moduleId = cap?.ownerModule ?? 'unknown'
      this.assertModuleEnabled(moduleId, capabilityId)
      // 如果模块启用但能力不可用，说明是依赖问题
      throw new Error(`[feature-gate] 能力不可用: ${capabilityId}`)
    }
  }

  // ==================== 权限检查（Phase 7） ====================

  /** 注册权限规则 */
  registerPermissionRule(rule: PermissionRule): void {
    let rules = this.permissionRules.get(rule.permission)
    if (!rules) {
      rules = []
      this.permissionRules.set(rule.permission, rules)
    }
    rules.push(rule)
    console.log(`[feature-gate] 已注册权限规则: ${rule.permission} (${rule.level})`)
  }

  /** 批量注册权限规则 */
  registerPermissionRules(rules: PermissionRule[]): void {
    for (const rule of rules) this.registerPermissionRule(rule)
  }

  /** 授予插件权限 */
  grantPermission(pluginId: string, permission: string): void {
    let perms = this.pluginPermissions.get(pluginId)
    if (!perms) {
      perms = new Set()
      this.pluginPermissions.set(pluginId, perms)
    }
    perms.add(permission)
  }

  /** 撤销插件权限 */
  revokePermission(pluginId: string, permission: string): void {
    this.pluginPermissions.get(pluginId)?.delete(permission)
  }

  /**
   * 检查权限。
   *
   * 判断逻辑：
   * 1. 内置模块（非插件）：默认允许所有权限
   * 2. 插件：检查插件权限白名单 + 权限规则
   * 3. 如果权限标签为空，视为无限制
   */
  hasPermission(capabilityId: string, pluginId?: string): boolean {
    const cap = capabilityRegistry.get(capabilityId)
    if (!cap) return false

    // 无权限标签 = 无限制
    if (!cap.permission) return true

    // 内置模块默认允许
    if (!pluginId) return true

    // 检查插件权限白名单
    const pluginPerms = this.pluginPermissions.get(pluginId)
    if (pluginPerms?.has(cap.permission)) return true

    // 检查权限规则
    const rules = this.permissionRules.get(cap.permission)
    if (rules) {
      for (const rule of rules) {
        // 检查插件是否在规则适用范围内
        if (rule.pluginIds && !rule.pluginIds.includes(pluginId)) continue
        // 检查能力是否在规则适用范围内
        if (rule.capabilityIds && !rule.capabilityIds.includes(capabilityId)) continue
        // 匹配到规则
        if (rule.level === 'allow') return true
        if (rule.level === 'deny') return false
        // 'ask' 需要用户确认，此处返回 false，由调用方处理
        return false
      }
    }

    // 默认：内置能力允许，外部插件拒绝
    return false
  }

  /** 断言权限，否则抛错 */
  assertPermission(capabilityId: string, pluginId?: string): void {
    if (!this.hasPermission(capabilityId, pluginId)) {
      const cap = capabilityRegistry.get(capabilityId)
      throw new Error(
        `[feature-gate] 权限不足: ${capabilityId} (需要 ${cap?.permission ?? 'unknown'}, 插件: ${pluginId ?? 'unknown'})`,
      )
    }
  }

  /** 获取插件的所有已授予权限 */
  getPluginPermissions(pluginId: string): string[] {
    const perms = this.pluginPermissions.get(pluginId)
    return perms ? [...perms] : []
  }

  /** 获取所有权限规则 */
  getPermissionRules(): PermissionRule[] {
    const result: PermissionRule[] = []
    for (const rules of this.permissionRules.values()) {
      result.push(...rules)
    }
    return result
  }
}

/** 单例 */
export const featureGate = new FeatureGateImpl()
