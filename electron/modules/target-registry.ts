// electron/modules/target-registry.ts — 统一目标注册表
//
// 统一追踪窗口、webview、tab、profile 和 document generation。
// 替代分散在各处的 target 追踪逻辑（如 freeze/webview-registry.ts）。
//
// 设计：
// - 每个目标有唯一 targetId（由 target type + id 组合）
// - 支持按 type、owner、profile 等维度查询
// - 目标销毁时自动清理关联的 EffectHandle
// - 与 InjectionBroker 配合，实现目标级批量撤销

import type { WebContents, BrowserWindow } from 'electron'

/** 目标类型 */
export type TargetType = 'window' | 'webview' | 'tab' | 'profile' | 'document'

/** 目标状态 */
export type TargetState = 'active' | 'destroyed' | 'navigating'

/** 目标记录 */
export interface TargetRecord {
  /** 唯一标识（由 type + 原始 id 组合） */
  targetId: string
  /** 目标类型 */
  type: TargetType
  /** 原始 id（窗口 id / tab id / webContents id 等） */
  nativeId: string
  /** 所属模块（创建此目标的模块） */
  ownerModule?: string
  /** 关联的 profile id */
  profileId?: string
  /** 关联的窗口 id */
  windowId?: string
  /** webContents id（webview/tab 类型） */
  webContentsId?: number
  /** 文档 generation（页面导航后递增） */
  documentGeneration?: number
  /** 注册时间 */
  registeredAt: number
  /** 最后更新时间 */
  updatedAt: number
  /** 目标状态 */
  state: TargetState
  /** 附加元数据 */
  metadata?: Record<string, unknown>
}

class TargetRegistryImpl {
  /** targetId → TargetRecord */
  private readonly targets = new Map<string, TargetRecord>()
  /** nativeId → targetId（索引） */
  private readonly byNativeId = new Map<string, string>()
  /** webContentsId → targetId（索引） */
  private readonly byWebContentsId = new Map<number, string>()
  /** type → Set<targetId>（索引） */
  private readonly byType = new Map<TargetType, Set<string>>()
  /** ownerModule → Set<targetId>（索引） */
  private readonly byOwner = new Map<string, Set<string>>()
  /** profileId → Set<targetId>（索引） */
  private readonly byProfile = new Map<string, Set<string>>()

  // ==================== 注册 ====================

  /** 注册目标 */
  register(record: Omit<TargetRecord, 'registeredAt' | 'updatedAt' | 'state'>): TargetRecord {
    const full: TargetRecord = {
      ...record,
      registeredAt: Date.now(),
      updatedAt: Date.now(),
      state: 'active',
    }

    // 如果已存在，先清理旧记录
    if (this.targets.has(record.targetId)) {
      this.unregister(record.targetId)
    }

    this.targets.set(record.targetId, full)
    this.byNativeId.set(record.nativeId, record.targetId)
    if (record.webContentsId !== undefined) {
      this.byWebContentsId.set(record.webContentsId, record.targetId)
    }

    // 索引：type
    let typeSet = this.byType.get(record.type)
    if (!typeSet) {
      typeSet = new Set()
      this.byType.set(record.type, typeSet)
    }
    typeSet.add(record.targetId)

    // 索引：owner
    if (record.ownerModule) {
      let ownerSet = this.byOwner.get(record.ownerModule)
      if (!ownerSet) {
        ownerSet = new Set()
        this.byOwner.set(record.ownerModule, ownerSet)
      }
      ownerSet.add(record.targetId)
    }

    // 索引：profile
    if (record.profileId) {
      let profileSet = this.byProfile.get(record.profileId)
      if (!profileSet) {
        profileSet = new Set()
        this.byProfile.set(record.profileId, profileSet)
      }
      profileSet.add(record.targetId)
    }

    console.log(`[target-registry] 已注册: ${record.targetId} (${record.type})`)
    return full
  }

  // ==================== 注销 ====================

  /** 注销目标 */
  unregister(targetId: string): boolean {
    const record = this.targets.get(targetId)
    if (!record) return false

    this.targets.delete(targetId)
    this.byNativeId.delete(record.nativeId)
    if (record.webContentsId !== undefined) {
      this.byWebContentsId.delete(record.webContentsId)
    }
    this.byType.get(record.type)?.delete(targetId)
    if (record.ownerModule) {
      this.byOwner.get(record.ownerModule)?.delete(targetId)
    }
    if (record.profileId) {
      this.byProfile.get(record.profileId)?.delete(targetId)
    }

    console.log(`[target-registry] 已注销: ${targetId}`)
    return true
  }

  // ==================== 更新 ====================

  /** 更新目标状态 */
  updateState(targetId: string, state: TargetState): boolean {
    const record = this.targets.get(targetId)
    if (!record) return false
    record.state = state
    record.updatedAt = Date.now()
    return true
  }

  /** 递增 document generation（页面导航时调用） */
  bumpDocumentGeneration(targetId: string): number {
    const record = this.targets.get(targetId)
    if (!record) return -1
    record.documentGeneration = (record.documentGeneration ?? 0) + 1
    record.updatedAt = Date.now()
    return record.documentGeneration
  }

  /** 更新元数据 */
  updateMetadata(targetId: string, metadata: Record<string, unknown>): boolean {
    const record = this.targets.get(targetId)
    if (!record) return false
    record.metadata = { ...record.metadata, ...metadata }
    record.updatedAt = Date.now()
    return true
  }

  // ==================== 查询 ====================

  /** 按 targetId 查询 */
  get(targetId: string): TargetRecord | undefined {
    return this.targets.get(targetId)
  }

  /** 按 nativeId 查询 */
  getByNativeId(nativeId: string): TargetRecord | undefined {
    const targetId = this.byNativeId.get(nativeId)
    return targetId ? this.targets.get(targetId) : undefined
  }

  /** 按 webContentsId 查询 */
  getByWebContentsId(webContentsId: number): TargetRecord | undefined {
    const targetId = this.byWebContentsId.get(webContentsId)
    return targetId ? this.targets.get(targetId) : undefined
  }

  /** 按类型查询 */
  getByType(type: TargetType): TargetRecord[] {
    const ids = this.byType.get(type)
    if (!ids) return []
    return [...ids].map((id) => this.targets.get(id)!).filter(Boolean)
  }

  /** 按所属模块查询 */
  getByOwner(moduleId: string): TargetRecord[] {
    const ids = this.byOwner.get(moduleId)
    if (!ids) return []
    return [...ids].map((id) => this.targets.get(id)!).filter(Boolean)
  }

  /** 按 profile 查询 */
  getByProfile(profileId: string): TargetRecord[] {
    const ids = this.byProfile.get(profileId)
    if (!ids) return []
    return [...ids].map((id) => this.targets.get(id)!).filter(Boolean)
  }

  /** 查询所有活跃目标 */
  getActive(): TargetRecord[] {
    return [...this.targets.values()].filter((r) => r.state === 'active')
  }

  /** 查询所有目标 */
  getAll(): TargetRecord[] {
    return [...this.targets.values()]
  }

  /** 统计 */
  getStats(): { total: number; active: number; byType: Record<TargetType, number> } {
    const byType: Record<TargetType, number> = {
      window: 0,
      webview: 0,
      tab: 0,
      profile: 0,
      document: 0,
    }
    let active = 0
    for (const record of this.targets.values()) {
      byType[record.type]++
      if (record.state === 'active') active++
    }
    return { total: this.targets.size, active, byType }
  }

  // ==================== 批量操作 ====================

  /** 标记模块的所有目标为 destroyed */
  markOwnerDestroyed(moduleId: string): number {
    const ids = this.byOwner.get(moduleId)
    if (!ids) return 0
    let count = 0
    for (const id of ids) {
      const record = this.targets.get(id)
      if (record && record.state === 'active') {
        record.state = 'destroyed'
        record.updatedAt = Date.now()
        count++
      }
    }
    return count
  }

  /** 清理所有 destroyed 状态的目标 */
  cleanupDestroyed(): number {
    const destroyed = [...this.targets.values()].filter((r) => r.state === 'destroyed')
    for (const record of destroyed) {
      this.unregister(record.targetId)
    }
    return destroyed.length
  }
}

/** 单例 */
export const targetRegistry = new TargetRegistryImpl()
