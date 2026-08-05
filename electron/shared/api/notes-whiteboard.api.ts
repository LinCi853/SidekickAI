// notes-whiteboard.api.ts — Notes / Whiteboard 接口

import type { Note, NoteSaveInput } from '../notes.types.js'
import type { WhiteboardState, WhiteboardMeta } from '../whiteboard.types.js'

/** 笔记列表筛选条件 */
export interface NoteListFilter {
  keyword?: string
  tag?: string
  pinnedOnly?: boolean
}

/**
 * 灵感笔记 API（需求 11）
 * 笔记浮窗的 CRUD + 激活笔记管理 + 发送到 AI 输入框 + 存为提示词。
 */
export interface NotesAPI {
  /** 列出笔记（支持搜索/标签/置顶筛选，按 pinned DESC, updatedAt DESC） */
  list(filter?: NoteListFilter): Promise<Note[]>
  /** 全文搜索（FTS5） */
  search(keyword: string): Promise<Note[]>
  /** 新增或更新笔记（upsert 语义：无 id 新增，有 id 更新） */
  save(input: NoteSaveInput): Promise<Note>
  /** 同步保存（beforeunload 兜底，sendSync） */
  saveSync(input: NoteSaveInput): { ok: boolean }
  /** 删除笔记 */
  delete(id: string): Promise<{ ok: boolean }>
  /** 获取当前激活的笔记（null=无激活） */
  getActive(): Promise<Note | null>
  /** 设置激活笔记（null=取消激活） */
  setActive(id: string | null): Promise<{ ok: boolean }>
  /** 设置置顶 */
  setPinned(id: string, pinned: boolean): Promise<{ ok: boolean }>
  /** 设置标签 */
  setTags(id: string, tags: string[]): Promise<{ ok: boolean }>
  /** 列出全部已用标签（去重） */
  listTags(): Promise<string[]>
  /** 发送笔记内容到当前 AI 输入框 */
  sendToAi(text: string, enterToSend?: boolean): Promise<{ ok: boolean; error?: string }>
  /** 把笔记内容保存为新的提示词模板 */
  saveAsPrompt(content: string, title?: string): Promise<{ ok: boolean; title?: string; error?: string }>
  /** 保存图片到磁盘，返回 notes-asset:// 路径（用于 markdown 中引用粘贴/拖拽的图片） */
  saveImage(dataUrl: string): Promise<{ ok: boolean; url?: string; error?: string }>
  /** 监听注入结果回传 */
  onInjectResult(callback: (result: { success: boolean; error?: string }) => void): () => void
}

/** 推送到白板的截图载荷 */
export interface WhiteboardPushImagePayload {
  /** whiteboard-asset:// 协议路径（主进程已保存到磁盘） */
  assetUrl: string
  /** 来源页面 URL（截图网页时记录） */
  sourceUrl?: string
  /** 来源 AI 平台名 */
  platform?: string
}

/**
 * 白板 API（v3：Excalidraw + 多白板）
 */
export interface WhiteboardAPI {
  /** 列出全部白板 */
  list(): Promise<WhiteboardMeta[]>
  /** 新建白板 */
  create(title?: string): Promise<WhiteboardMeta>
  /** 重命名白板 */
  rename(id: string, title: string): Promise<{ ok: boolean }>
  /** 删除白板 */
  delete(id: string): Promise<{ ok: boolean }>
  /** 获取激活白板 id */
  getActive(): Promise<string | null>
  /** 设置激活白板 id */
  setActive(id: string | null): Promise<{ ok: boolean }>
  /** 加载白板 snapshot（Excalidraw scene JSON，无则 null） */
  getSnapshot(id: string): Promise<string | null>
  /** 异步保存 snapshot */
  saveSnapshot(id: string, snapshot: string): Promise<{ ok: boolean }>
  /** 同步保存 snapshot（beforeunload 兜底） */
  saveSnapshotSync(id: string, snapshot: string): { ok: boolean }
  /** 需求 12：保存截图 dataURL 到磁盘，返回 whiteboard-asset:// 路径 */
  saveImage(dataUrl: string): Promise<string>
  /** 需求 12：推送截图到白板（主进程打开进阶面板 + 切 tab + 转发载荷给白板渲染层） */
  pushImage(payload: WhiteboardPushImagePayload): Promise<{ ok: boolean }>
  /** 主→渲染：白板窗口接收推送的截图（WhiteboardView 订阅后注入 Excalidraw 图片元素） */
  onPushImage(callback: (payload: WhiteboardPushImagePayload) => void): () => void
}
