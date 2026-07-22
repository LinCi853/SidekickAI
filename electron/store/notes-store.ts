// electron/store/notes-store.ts — 灵感笔记持久化存储 + IPC 注册
//
// 需求 11：全局灵感笔记浮窗的数据层。
// 持久化到 notes.json（electron-store），结构：
//   { notes: Note[], activeId: string | null, version: 1 }
//
// Note 字段：id / content / createdAt / updatedAt / windowTitle? / aiPlatform?
// 单例 store，IPC 注册函数 registerNotesIPC()。

import Store from 'electron-store'
import { randomUUID } from 'crypto'
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../shared/types.js'
import type { Note, NoteSaveInput } from '../shared/notes.types.js'
import { getStoreCwd } from './store-paths.js'

// re-export 共享类型，保持向后兼容（其他模块从 notes-store 导入 Note）
export type { Note, NoteSaveInput }

type NotesStoreShape = {
  notes: Note[]
  /** 当前激活的笔记 id（null=无激活，浮窗显示空白） */
  activeId: string | null
  version: number
}

const store = new Store<NotesStoreShape>({
  name: 'notes',
  cwd: getStoreCwd(),
  defaults: { notes: [], activeId: null, version: 1 },
})

export class NotesStore {
  /** 列出全部笔记（按 updatedAt 降序） */
  list(): Note[] {
    const notes = store.get('notes')
    return [...notes].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 新增或更新笔记（upsert 语义）。无 id 时新增；有 id 时更新。 */
  save(input: NoteSaveInput): Note {
    const notes = store.get('notes')
    const now = Date.now()
    if (input.id) {
      const idx = notes.findIndex((n) => n.id === input.id)
      if (idx !== -1) {
        const updated: Note = {
          ...notes[idx],
          ...input,
          id: notes[idx].id,
          createdAt: notes[idx].createdAt,
          updatedAt: now,
        }
        notes[idx] = updated
        store.set('notes', notes)
        return updated
      }
    }
    // 新增
    const created: Note = {
      id: input.id || randomUUID(),
      content: input.content,
      createdAt: now,
      updatedAt: now,
      windowTitle: input.windowTitle,
      aiPlatform: input.aiPlatform,
    }
    notes.push(created)
    store.set('notes', notes)
    // 自动设为激活
    store.set('activeId', created.id)
    return created
  }

  /** 删除笔记；若删除的是激活笔记，activeId 置 null */
  delete(id: string): void {
    const notes = store.get('notes').filter((n) => n.id !== id)
    store.set('notes', notes)
    if (store.get('activeId') === id) {
      store.set('activeId', null)
    }
  }

  /** 获取当前激活的笔记（null=无激活） */
  getActive(): Note | null {
    const activeId = store.get('activeId')
    if (!activeId) return null
    const notes = store.get('notes')
    return notes.find((n) => n.id === activeId) ?? null
  }

  /** 设置激活笔记（null=取消激活） */
  setActive(id: string | null): void {
    if (id === null) {
      store.set('activeId', null)
      return
    }
    const exists = store.get('notes').some((n) => n.id === id)
    if (!exists) return
    store.set('activeId', id)
  }
}

export const notesStore = new NotesStore()

/** 注册笔记相关 IPC handler（在 app.whenReady() 后调用） */
export function registerNotesIPC(): void {
  const ipc = IPC_CHANNELS
  ipcMain.handle(ipc.NOTES_LIST, () => notesStore.list())
  ipcMain.handle(ipc.NOTES_SAVE, (_e, input: Parameters<NotesStore['save']>[0]) =>
    notesStore.save(input),
  )
  ipcMain.handle(ipc.NOTES_DELETE, (_e, id: string) => {
    notesStore.delete(id)
    return { ok: true }
  })
  ipcMain.handle(ipc.NOTES_GET_ACTIVE, () => notesStore.getActive())
  ipcMain.handle(ipc.NOTES_SET_ACTIVE, (_e, id: string | null) => {
    notesStore.setActive(id)
    return { ok: true }
  })
}
