// electron/store/migrate-whiteboard-notes.ts — 一次性迁移：electron-store JSON → SQLite
//
// 应用启动时（app.whenReady 后、注册 IPC 前）调用 migrateWhiteboardNotes()。
// - 检测旧 whiteboard.json → 转为单条"迁移白板"+ legacy 数据 → 写入 whiteboard.db → 旧文件改名 .bak
// - 检测旧 notes.json → 逐条迁移为 Note（content_json 用 TipTap 纯文本段落 doc）→ 写入 notes.db → 旧文件改名 .bak
// - 幂等：旧文件不存在则跳过。

// electron-store 可能未安装（Phase 3 已完成迁移），用 try/import 保护
let Store: any
try {
  Store = require('electron-store').default ?? require('electron-store')
} catch {
  Store = null
}
import { existsSync, renameSync } from 'fs'
import path from 'path'
import { getStoreCwd, getModuleDirname } from './store-paths.js'
import { getWhiteboardDb } from './whiteboard-db.js'
import { getNotesDb } from './notes-db.js'
import type { WhiteboardState } from '../shared/whiteboard.types.js'
import type { Note, NoteSaveInput } from '../shared/notes.types.js'

/** 旧 whiteboard.json 的 schema（electron-store） */
type LegacyWhiteboardShape = WhiteboardState & { version: number }

/** 旧 notes.json 的 schema（electron-store） */
interface LegacyNotesShape {
  notes: Array<{
    id: string
    content: string
    createdAt: number
    updatedAt: number
    windowTitle?: string
    aiPlatform?: string
  }>
  activeId: string | null
  version: number
}

/** 将纯文本转为 TipTap ProseMirror JSON（每行一个 paragraph） */
function plainTextToTipTapJson(text: string): string {
  const lines = text.split('\n')
  const paragraphs = lines.map((line) => ({
    type: 'paragraph',
    content: line.length > 0 ? [{ type: 'text', text: line }] : [],
  }))
  return JSON.stringify({ type: 'doc', content: paragraphs })
}

/** 迁移白板：旧 JSON → SQLite（legacy 数据存 meta，渲染层首次加载时转换） */
function migrateWhiteboard(): void {
  const cwd = getStoreCwd()
  const legacyPath = cwd ? path.join(cwd, 'whiteboard.json') : null
  if (!legacyPath || !existsSync(legacyPath)) return

  try {
    const legacyStore = new Store({
      name: 'whiteboard',
      cwd: cwd ?? undefined,
    })
    const state = legacyStore.store as LegacyWhiteboardShape
    const db = getWhiteboardDb()

    // 创建"迁移白板"
    const wb = db.createWhiteboard('迁移白板')

    // 将旧状态存入 snapshot，渲染层首次加载时转换为 Excalidraw 元素
    if (state.cards?.length || state.arrows?.length || state.strokes?.length) {
      db.saveSnapshot(wb.id, JSON.stringify({
        __legacy: true,
        cards: state.cards ?? [],
        arrows: state.arrows ?? [],
        strokes: state.strokes ?? [],
        viewport: state.viewport ?? { x: 0, y: 0, zoom: 1 },
      }))
    }

    db.setActiveWhiteboardId(wb.id)
    console.log(`[migrate] 白板迁移完成：${state.cards?.length ?? 0} 张卡片 → 白板 "${wb.id}"`)

    // 旧文件改名 .bak
    renameSync(legacyPath, legacyPath + '.bak')
    console.log('[migrate] 旧 whiteboard.json 已重命名为 whiteboard.json.bak')
  } catch (err) {
    console.error('[migrate] 白板迁移失败:', err)
  }
}

/** 迁移笔记：旧 JSON → SQLite（content_json 用 TipTap 纯文本段落） */
function migrateNotes(): void {
  const cwd = getStoreCwd()
  const legacyPath = cwd ? path.join(cwd, 'notes.json') : null
  if (!legacyPath || !existsSync(legacyPath)) return

  try {
    const legacyStore = new Store({
      name: 'notes',
      cwd: cwd ?? undefined,
    })
    const data = legacyStore.store as LegacyNotesShape
    const db = getNotesDb()

    let migratedCount = 0
    for (const oldNote of data.notes ?? []) {
      const input: NoteSaveInput = {
        id: oldNote.id,
        content: oldNote.content,
        contentJson: plainTextToTipTapJson(oldNote.content),
        windowTitle: oldNote.windowTitle,
        aiPlatform: oldNote.aiPlatform,
      }
      db.saveNote(input)
      migratedCount++
    }

    // 迁移 activeId
    if (data.activeId) {
      db.setActiveNoteId(data.activeId)
    }

    console.log(`[migrate] 笔记迁移完成：${migratedCount} 条`)

    // 旧文件改名 .bak
    renameSync(legacyPath, legacyPath + '.bak')
    console.log('[migrate] 旧 notes.json 已重命名为 notes.json.bak')
  } catch (err) {
    console.error('[migrate] 笔记迁移失败:', err)
  }
}

/** 一次性迁移入口（幂等，旧文件不存在则跳过） */
export function migrateWhiteboardNotes(): void {
  try {
    migrateWhiteboard()
    migrateNotes()
  } catch (err) {
    console.error('[migrate] 迁移过程异常:', err)
  }
}
