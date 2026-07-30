// electron/store/prompt-store.ts — 提示词模板持久化存储 + IPC 注册
//
// 使用 electron-store 将提示词模板持久化到磁盘（prompts.json）。
// 提供模板的 CRUD 接口，供「明输入明注入」功能使用。
// 首次启动自动填充若干通用预置模板，便于用户即刻体验。

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import fs from 'fs'
import type { PromptTemplate } from '../shared/types.js'
import { IPC_CHANNELS } from '../shared/types.js'
import { createJsonStore, createCrudStore } from './store-paths.js'

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
 *
 * 标准 list/save/delete 委托给 createCrudStore 工厂；
 * list 保持按 createdAt 升序、save 始终刷新 updatedAt 等业务规则仍在本类中实现。
 */
export class PromptStore {
  /** 标准 CRUD 操作集（基于 electron-store 的 prompts 数组） */
  private crud = createCrudStore<PromptTemplate>({ store, key: 'prompts' })

  /** 读取全部模板（按创建时间升序） */
  list(): PromptTemplate[] {
    return [...this.crud.list()].sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * 新增或更新模板（upsert 语义）。
   * 按 id 查找：存在则更新（保留 createdAt，刷新 updatedAt）；不存在则新增（补全 id 与时间戳）。
   */
  save(template: PromptTemplate): PromptTemplate {
    const id = template.id || randomUUID()
    const toSave: PromptTemplate = { ...template, id, updatedAt: Date.now() }
    this.crud.save(toSave)
    return toSave
  }

  /** 删除模板 */
  delete(id: string): void {
    this.crud.delete(id)
  }

  /** 导出全部提示词为 JSON 字符串 */
  exportPrompts(): string {
    return JSON.stringify({ version: 1, prompts: this.list() }, null, 2)
  }

  /**
   * 导入提示词（合并模式：同 id 覆盖，新 id 新增）。
   * @returns 新增数与更新数
   */
  importPrompts(json: string): { added: number; updated: number } {
    const data = JSON.parse(json) as { prompts?: PromptTemplate[] }
    const incoming = Array.isArray(data?.prompts) ? data.prompts : []
    const existing = new Map(this.list().map((p) => [p.id, p]))
    let added = 0
    let updated = 0
    for (const p of incoming) {
      if (!p || typeof p !== 'object' || !p.title || typeof p.content !== 'string') continue
      if (existing.has(p.id)) updated++
      else added++
      this.save(p)
    }
    return { added, updated }
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

  // 导出全部提示词为 JSON 文件（主进程弹保存对话框 + 写文件）
  ipcMain.handle(ipc.PROMPT_EXPORT, async (e) => {
    try {
      const win = BrowserWindow.fromWebContents(e.sender)
      const { canceled, filePath } = await dialog.showSaveDialog(win!, {
        title: '导出提示词',
        defaultPath: 'prompts-backup.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      if (canceled || !filePath) return { ok: false, canceled: true }
      const json = promptStore.exportPrompts()
      fs.writeFileSync(filePath, json, 'utf-8')
      console.log('[prompt-store] 导出成功:', filePath)
      return { ok: true, filePath }
    } catch (err) {
      console.error('[prompt-store] 导出失败:', err)
      return { ok: false, error: String(err) }
    }
  })

  // 导入提示词 JSON 文件（主进程弹打开对话框 + 读文件 + 合并入库）
  ipcMain.handle(ipc.PROMPT_IMPORT, async (e) => {
    try {
      const win = BrowserWindow.fromWebContents(e.sender)
      const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
        title: '导入提示词',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
      })
      if (canceled || !filePaths?.[0]) return { ok: false, canceled: true }
      const json = fs.readFileSync(filePaths[0], 'utf-8')
      const result = promptStore.importPrompts(json)
      console.log('[prompt-store] 导入成功:', result)
      return { ok: true, ...result }
    } catch (err) {
      console.error('[prompt-store] 导入失败:', err)
      return { ok: false, error: String(err) }
    }
  })
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
