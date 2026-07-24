// electron/store/prompt-store.ts — 提示词模板持久化存储 + IPC 注册
//
// 使用 electron-store 将提示词模板持久化到磁盘（prompts.json）。
// 提供模板的 CRUD 接口，供「明输入明注入」功能使用。
// 首次启动自动填充若干通用预置模板，便于用户即刻体验。

import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import type { PromptTemplate } from '../shared/types.js'
import { IPC_CHANNELS } from '../shared/types.js'
import { createJsonStore } from './store-paths.js'

// 持久化存储实例（写入 prompts.json）
// 开发环境：写入项目内 .app-data/ 目录，规避 TRAE 沙箱对 AppData\Roaming 的写入限制
// 生产环境：使用默认 userData 路径
const store = createJsonStore<{ prompts: PromptTemplate[]; version: number }>({
  name: 'prompts',
  defaults: { prompts: [], version: 1 },
})

/** 首次启动填充的通用预置模板 */
const DEFAULT_PROMPTS: Array<Omit<PromptTemplate, 'id' | 'createdAt' | 'updatedAt'>> = [
  { title: '总结全文', content: '请用简洁的语言总结以下内容的要点，分条列出：\n\n{{body}}', category: '通用' },
  { title: '翻译为英文', content: '请将以下内容翻译为自然流畅的英文：\n\n{{body}}', category: '通用' },
  { title: '扩写细节', content: '请在保持原意的基础上，扩写以下内容，补充更多细节与示例：\n\n{{body}}', category: '通用' },
  { title: '润色优化', content: '请润色以下文字，使其更专业、流畅，并保留原意：\n\n{{body}}', category: '通用' },
  { title: '解释代码', content: '请逐行解释以下代码的作用与实现思路：\n\n{{body}}', category: '开发' },
]

/**
 * 提示词模板持久化存储：CRUD 操作
 */
export class PromptStore {
  /** 读取全部模板（按创建时间升序） */
  list(): PromptTemplate[] {
    const prompts = store.get('prompts')
    return [...prompts].sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * 新增或更新模板（upsert 语义）。
   * 按 id 查找：存在则更新（保留 createdAt，刷新 updatedAt）；不存在则新增（补全 id 与时间戳）。
   */
  save(template: PromptTemplate): PromptTemplate {
    const prompts = store.get('prompts')
    const id = template.id || randomUUID()
    const now = Date.now()
    const idx = prompts.findIndex((p) => p.id === id)
    const toSave: PromptTemplate = { ...template, id, updatedAt: now }
    if (idx === -1) {
      prompts.push(toSave)
    } else {
      prompts[idx] = toSave
    }
    store.set('prompts', prompts)
    return toSave
  }

  /** 删除模板 */
  delete(id: string): void {
    const prompts = store.get('prompts')
    store.set(
      'prompts',
      prompts.filter((p) => p.id !== id),
    )
  }
}

// 单例实例
export const promptStore = new PromptStore()

/**
 * 注册提示词模板 CRUD IPC 处理器
 * 在 app.whenReady() 后调用。
 */
export function registerPromptIPC(): void {
  const ipc = IPC_CHANNELS
  ipcMain.handle(ipc.PROMPT_LIST, () => promptStore.list())
  ipcMain.handle(ipc.PROMPT_SAVE, (_e, template: PromptTemplate) =>
    promptStore.save(template),
  )
  ipcMain.handle(ipc.PROMPT_DELETE, (_e, id: string) => promptStore.delete(id))
}

/**
 * v0.5.2 regress-5：检测并迁移含旧字段（prefix/suffix/injectionPosition）的模板。
 * 用户要求：不迁移旧数据，直接整文替换为 DEFAULT_PROMPTS。
 * 仅在检测到旧字段时触发替换；无旧字段则不做任何操作。
 */
function migrateLegacyPrompts(): void {
  const existing = store.get('prompts')
  if (existing.length === 0) return

  // 检测是否存在含旧字段的模板
  const hasLegacy = existing.some(
    (p: unknown) =>
      p != null &&
      typeof p === 'object' &&
      ('prefix' in p || 'suffix' in p || 'injectionPosition' in p),
  )
  if (!hasLegacy) return

  // 整文替换：清空旧模板，用 DEFAULT_PROMPTS 填充
  store.set('prompts', [])
  for (const p of DEFAULT_PROMPTS) {
    promptStore.save({
      id: randomUUID(),
      title: p.title,
      content: p.content,
      category: p.category,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  }
  console.log('[prompt-store] 迁移：检测到旧格式模板，已整文替换为默认模板')
}

/**
 * 首次启动自动填充通用预置模板
 * 仅在 store 中模板为空时填充。
 */
export function ensureDefaultPrompts(): void {
  migrateLegacyPrompts()
  const existing = store.get('prompts')
  if (existing.length > 0) return

  for (const p of DEFAULT_PROMPTS) {
    promptStore.save({
      id: randomUUID(),
      title: p.title,
      content: p.content,
      category: p.category,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  }

  console.log(`[prompt-store] 首次启动：填充 ${DEFAULT_PROMPTS.length} 条预置提示词模板`)
}
