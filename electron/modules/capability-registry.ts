// electron/modules/capability-registry.ts — 功能贡献登记表
//
// 集中登记所有模块的能力声明，供 FeatureGate 查询和 InjectionBroker 路由。
// 能力声明来自 ModuleManifest.capabilities（Phase 2 扩展），或运行期动态注册。

import type { CapabilityRef, EffectKind } from '../shared/module-manifest.types.js'

class CapabilityRegistryImpl {
  /** capabilityId → CapabilityRef */
  private readonly caps = new Map<string, CapabilityRef>()
  /** moduleId → Set<capabilityId>（索引） */
  private readonly byModule = new Map<string, Set<string>>()
  /** kind → Set<capabilityId>（索引） */
  private readonly byKind = new Map<EffectKind, Set<string>>()

  /** 注册能力声明（重复注册抛错） */
  register(cap: CapabilityRef): void {
    if (this.caps.has(cap.capabilityId)) {
      throw new Error(`[capability-registry] 能力重复注册: ${cap.capabilityId}`)
    }
    this.caps.set(cap.capabilityId, cap)

    // 索引：module → capabilities
    let moduleCaps = this.byModule.get(cap.ownerModule)
    if (!moduleCaps) {
      moduleCaps = new Set()
      this.byModule.set(cap.ownerModule, moduleCaps)
    }
    moduleCaps.add(cap.capabilityId)

    // 索引：kind → capabilities
    let kindCaps = this.byKind.get(cap.kind)
    if (!kindCaps) {
      kindCaps = new Set()
      this.byKind.set(cap.kind, kindCaps)
    }
    kindCaps.add(cap.capabilityId)
  }

  /** 批量注册 */
  registerMany(caps: CapabilityRef[]): void {
    for (const cap of caps) this.register(cap)
  }

  /** 查询能力声明 */
  get(capabilityId: string): CapabilityRef | undefined {
    return this.caps.get(capabilityId)
  }

  /** 查询模块拥有的全部能力 */
  getByModule(moduleId: string): CapabilityRef[] {
    const ids = this.byModule.get(moduleId)
    if (!ids) return []
    return [...ids].map((id) => this.caps.get(id)!).filter(Boolean)
  }

  /** 查询指定 kind 的全部能力 */
  getByKind(kind: EffectKind): CapabilityRef[] {
    const ids = this.byKind.get(kind)
    if (!ids) return []
    return [...ids].map((id) => this.caps.get(id)!).filter(Boolean)
  }

  /** 查询所有已注册的能力 */
  getAll(): CapabilityRef[] {
    return [...this.caps.values()]
  }

  /** 移除模块的全部能力（模块卸载时） */
  unregisterModule(moduleId: string): void {
    const ids = this.byModule.get(moduleId)
    if (!ids) return
    for (const id of ids) {
      const cap = this.caps.get(id)
      if (cap) {
        this.byKind.get(cap.kind)?.delete(id)
      }
      this.caps.delete(id)
    }
    this.byModule.delete(moduleId)
  }

  /** 检查能力是否已注册 */
  has(capabilityId: string): boolean {
    return this.caps.has(capabilityId)
  }
}

/** 单例 */
export const capabilityRegistry = new CapabilityRegistryImpl()
