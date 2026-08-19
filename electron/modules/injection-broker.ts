// electron/modules/injection-broker.ts — 统一注入协调器
//
// InjectionBroker 是所有副作用注入的统一入口。它接收 InjectionRequest，
// 通过 FeatureGate 校验后，路由到对应的 TargetAdapter 执行，并返回
// 可撤销的 EffectHandle。
//
// 设计原则：
// - 所有副作用都通过 Broker 注册，不直接调用底层 API
// - 每次注入返回 EffectHandle，挂到 EffectScope 上
// - 模块关闭时 Broker.revokeModule() 统一撤销
// - 目标销毁时 Broker.revokeTarget() 统一撤销

import type { EffectHandle, EffectKind } from './effect-scope.js'
import type { EffectScope } from './effect-scope.js'
import type { TargetAdapter } from './adapters/types.js'
import { featureGate } from './feature-gate.js'
import { capabilityRegistry } from './capability-registry.js'

/** 注入请求 */
export interface InjectionRequest {
  /** 请求来源模块 */
  ownerModule: string
  /** 能力标识 */
  capabilityId: string
  /** 副作用类型 */
  kind: EffectKind
  /** 注入目标（可选，全局级为空） */
  target?: {
    type: 'window' | 'tab' | 'webview'
    id: string
  }
  /** kind-specific 载荷（由 adapter 解释） */
  payload: unknown
}

/** 注入审计记录 */
export interface InjectionAuditEntry {
  handle: EffectHandle
  request: InjectionRequest
  injectedAt: number
}

class InjectionBrokerImpl {
  /** kind → adapter */
  private readonly adapters = new Map<EffectKind, TargetAdapter>()
  /** ownerModule → EffectHandle[]（索引） */
  private readonly byModule = new Map<string, Set<EffectHandle>>()
  /** targetId → EffectHandle[]（索引） */
  private readonly byTarget = new Map<string, Set<EffectHandle>>()
  /** 全局句柄集合 */
  private readonly allHandles = new Set<EffectHandle>()
  /** 审计日志（最近 N 条） */
  private readonly auditLog: InjectionAuditEntry[] = []
  private static readonly MAX_AUDIT = 200

  // ==================== 适配器注册 ====================

  /** 注册适配器（启动时调用） */
  registerAdapter(adapter: TargetAdapter): void {
    this.adapters.set(adapter.kind, adapter)
    console.log(`[injection-broker] 已注册适配器: ${adapter.kind}`)
  }

  /** 批量注册 */
  registerAdapters(adapters: TargetAdapter[]): void {
    for (const a of adapters) this.registerAdapter(a)
  }

  // ==================== 统一注入入口 ====================

  /**
   * 统一注入入口：校验 → 路由 → 记录 → 返回句柄。
   *
   * @param request 注入请求
   * @param scope 所属模块的 EffectScope（句柄自动登记到此 scope）
   * @returns 可撤销的 EffectHandle
   * @throws 模块未启用或能力不可用时抛错
   */
  async inject(request: InjectionRequest, scope: EffectScope): Promise<EffectHandle> {
    // 1. FeatureGate 校验
    featureGate.assertModuleEnabled(request.ownerModule, request.capabilityId)

    // 2. 能力校验（如果已注册）
    if (capabilityRegistry.has(request.capabilityId)) {
      featureGate.assertCapability(request.capabilityId)
    }

    // 3. 路由到 adapter
    const adapter = this.adapters.get(request.kind)
    if (!adapter) {
      throw new Error(`[injection-broker] 未注册适配器: ${request.kind}`)
    }

    // 4. 执行注入
    const handle = await adapter.apply(request, scope)

    // 5. 索引和审计
    this.indexHandle(handle, request)

    // 6. 登记到 scope
    scope.track(handle)

    return handle
  }

  // ==================== 批量撤销 ====================

  /** 撤销某模块的全部注入 */
  async revokeModule(moduleId: string): Promise<void> {
    const handles = this.byModule.get(moduleId)
    if (!handles || handles.size === 0) return

    const list = [...handles]
    handles.clear()
    this.byModule.delete(moduleId)

    for (const handle of list) {
      this.allHandles.delete(handle)
      // 从 target 索引中移除
      if (handle.targetId) {
        this.byTarget.get(handle.targetId)?.delete(handle)
      }
      try {
        await handle.dispose()
      } catch (err) {
        console.warn(`[injection-broker] 撤销 ${handle.capabilityId} 失败:`, err)
      }
    }

    console.log(`[injection-broker] 已撤销模块 ${moduleId} 的 ${list.length} 个注入`)
  }

  /** 撤销某目标的全部注入（webview 销毁 / 标签关闭时） */
  async revokeTarget(targetId: string): Promise<void> {
    const handles = this.byTarget.get(targetId)
    if (!handles || handles.size === 0) return

    const list = [...handles]
    handles.clear()
    this.byTarget.delete(targetId)

    for (const handle of list) {
      this.allHandles.delete(handle)
      // 从 module 索引中移除
      this.byModule.get(handle.ownerModule)?.delete(handle)
      try {
        await handle.dispose()
      } catch (err) {
        console.warn(`[injection-broker] 撤销目标 ${targetId} 的 ${handle.capabilityId} 失败:`, err)
      }
    }

    console.log(`[injection-broker] 已撤销目标 ${targetId} 的 ${list.length} 个注入`)
  }

  // ==================== 查询 ====================

  /** 查询模块当前活跃的注入数 */
  getModuleInjectionCount(moduleId: string): number {
    return this.byModule.get(moduleId)?.size ?? 0
  }

  /** 查询目标当前活跃的注入数 */
  getTargetInjectionCount(targetId: string): number {
    return this.byTarget.get(targetId)?.size ?? 0
  }

  /** 查询全部活跃注入数 */
  getTotalInjectionCount(): number {
    return this.allHandles.size
  }

  /** 获取审计日志 */
  getAuditLog(): InjectionAuditEntry[] {
    return [...this.auditLog]
  }

  // ==================== 内部 ====================

  private indexHandle(handle: EffectHandle, request: InjectionRequest): void {
    this.allHandles.add(handle)

    // module 索引
    let moduleHandles = this.byModule.get(handle.ownerModule)
    if (!moduleHandles) {
      moduleHandles = new Set()
      this.byModule.set(handle.ownerModule, moduleHandles)
    }
    moduleHandles.add(handle)

    // target 索引
    if (handle.targetId) {
      let targetHandles = this.byTarget.get(handle.targetId)
      if (!targetHandles) {
        targetHandles = new Set()
        this.byTarget.set(handle.targetId, targetHandles)
      }
      targetHandles.add(handle)
    }

    // 审计
    this.auditLog.push({ handle, request, injectedAt: Date.now() })
    if (this.auditLog.length > InjectionBrokerImpl.MAX_AUDIT) {
      this.auditLog.splice(0, this.auditLog.length - InjectionBrokerImpl.MAX_AUDIT)
    }
  }
}

/** 单例 */
export const injectionBroker = new InjectionBrokerImpl()
