// block-rules-store.ts — 页面组件屏蔽规则持久化存储 + IPC 注册
//
// 持久化到 SQLite settings.db（rules 表，createSqliteJsonStore）。
// 首次启动自动填充预置规则（按平台域名匹配常见屏蔽目标）。
// 与 prompt-store.ts 模式一致。

import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import type { BlockRule } from '../shared/block-rules.types.js'
import { IPC_CHANNELS } from '../shared/types.js'
import { createCrudStore } from './store-paths.js'
import { createSqliteJsonStore } from './module-state-store.js'
import { DEFAULT_BLOCK_RULES } from './block-rules-default.js'

// 持久化存储实例（写入 block-rules.json）
const store = createSqliteJsonStore<{ rules: BlockRule[]; version: number }>({
  tableName: 'block_rules',
  legacyName: 'block-rules',
  defaults: { rules: [], version: 1 },
})

/**
 * 页面组件屏蔽规则存储：CRUD 操作
 *
 * 标准 list/save/delete/update 委托给 createCrudStore 工厂；
 * 内置规则保护（builtin 不可删除）等业务规则仍在本类中实现。
 */
export class BlockRulesStore {
  /** 标准 CRUD 操作集（基于 electron-store 的 rules 数组） */
  private crud = createCrudStore<BlockRule>({ store, key: 'rules' })

  /** 读取全部规则 */
  list(): BlockRule[] {
    return this.crud.list() as BlockRule[]
  }

  /** 新增或更新规则（upsert 语义） */
  save(rule: BlockRule): BlockRule {
    const existing = this.crud.get(rule.id)
    const toSave: BlockRule = existing
      ? { ...rule, id: existing.id }
      : { ...rule, id: rule.id || randomUUID() }
    this.crud.save(toSave)
    return toSave
  }

  /** 删除规则（内置规则不可删除） */
  delete(id: string): void {
    const rule = this.crud.get(id)
    if (rule?.builtin) {
      console.warn('[block-rules-store] 内置规则不可删除:', id)
      return
    }
    this.crud.delete(id)
  }

  /** 更新规则（部分字段） */
  update(id: string, patch: Partial<BlockRule>): BlockRule | null {
    const existing = this.crud.get(id)
    if (!existing) return null
    this.crud.update(id, patch)
    return { ...existing, ...patch, id }
  }
}

// 单例实例
export const blockRulesStore = new BlockRulesStore()

/**
 * 注册屏蔽规则 CRUD IPC 处理器
 */
export function registerBlockRulesIPC(): void {
  const ipc = IPC_CHANNELS
  ipcMain.handle(ipc.BLOCK_RULES_LIST, () => blockRulesStore.list())
  ipcMain.handle(ipc.BLOCK_RULES_SAVE, (_e, rule: BlockRule) =>
    blockRulesStore.save(rule),
  )
  ipcMain.handle(ipc.BLOCK_RULES_DELETE, (_e, id: string) =>
    blockRulesStore.delete(id),
  )
  ipcMain.handle(ipc.BLOCK_RULES_UPDATE, (_e, id: string, patch: Partial<BlockRule>) =>
    blockRulesStore.update(id, patch),
  )
}

/**
 * 首次启动自动填充预置屏蔽规则
 * 仅在 store 中规则为空时填充。
 * 已存在的内置规则按 id 更新内容（确保选择器等修正能同步到旧安装）。
 */
export function ensureDefaultBlockRules(): void {
  const existing = store.get('rules') as BlockRule[]
  if (existing.length === 0) {
    // 首次启动：填充全部预置规则
    for (const rule of DEFAULT_BLOCK_RULES) {
      blockRulesStore.save(rule)
    }
    console.log(`[block-rules-store] 首次启动：填充 ${DEFAULT_BLOCK_RULES.length} 条预置屏蔽规则`)
    return
  }

  // 已有规则：同步内置规则的内容修正（按 id 匹配，更新 selector/jsCode/label，保留 enabled 状态）
  let updated = 0
  for (const defRule of DEFAULT_BLOCK_RULES) {
    const idx = existing.findIndex((r) => r.id === defRule.id)
    if (idx !== -1) {
      const current = existing[idx]
      // 仅在内置规则内容有变化时更新，保留用户对 enabled 的修改
      if (current.selector !== defRule.selector || current.jsCode !== defRule.jsCode || current.label !== defRule.label) {
        existing[idx] = { ...defRule, enabled: current.enabled }
        updated++
      }
    } else {
      // 新增的内置规则（版本升级时补充）
      existing.push(defRule)
      updated++
    }
  }
  if (updated > 0) {
    store.set('rules', existing)
    console.log(`[block-rules-store] 同步 ${updated} 条内置规则修正`)
  }

  // ===== 一次性迁移：强制关闭智谱清言下载屏蔽规则（选择器过于宽泛影响登录） =====
  // 迁移条件为「规则存在且 enabled」，迁移后 enabled=false，下次启动自动跳过，无需额外标记位
  const currentRules = store.get('rules') as BlockRule[]
  const needMigrate = currentRules.some(
    (r) => (r.id === 'builtin-chatglm-download' || r.id === 'builtin-chatglm-download-js') && r.enabled,
  )
  if (needMigrate) {
    let changed = false
    for (const r of currentRules) {
      if ((r.id === 'builtin-chatglm-download' || r.id === 'builtin-chatglm-download-js') && r.enabled) {
        r.enabled = false
        changed = true
      }
    }
    if (changed) {
      store.set('rules', currentRules)
      console.log('[block-rules-store] 一次性迁移：已关闭智谱清言下载屏蔽规则（影响登录）')
    }
  }
}

/**
 * 获取匹配指定域名的启用规则
 * @param hostname 当前页面 hostname，如 'chatgpt.com'
 * @returns 匹配的启用规则列表
 */
export function getMatchingRules(hostname: string): BlockRule[] {
  const rules = store.get('rules') as BlockRule[]
  return rules.filter((r) => r.enabled && matchDomain(r.domainPattern, hostname))
}

/**
 * glob 域名匹配
 * '*' 匹配所有；'*.chatgpt.com' 匹配 'chatgpt.com' 及其子域名
 */
function matchDomain(pattern: string, hostname: string): boolean {
  if (pattern === '*') return true
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2)
    return hostname === base || hostname.endsWith('.' + base)
  }
  return hostname === pattern || hostname.endsWith('.' + pattern)
}
