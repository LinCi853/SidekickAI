// notes.types.ts — 灵感笔记数据类型
// 由 shared/types.ts 拆分而来；类型定义内容保持原样，仅做物理拆分。
// 主进程 / Preload / 渲染进程共享，避免循环依赖。

/** 一条灵感笔记（v2：富文本 + 搜索 + 分类） */
export interface Note {
  /** 唯一 id（UUID） */
  id: string
  /** 显式标题（可空，空时由正文首行推导） */
  title: string | null
  /** 笔记正文纯文本（用于搜索 + 标题推导 + 发送到 AI） */
  content: string
  /** 笔记正文 TipTap ProseMirror JSON（富文本结构） */
  contentJson: string
  /** 是否置顶 */
  pinned: boolean
  /** 标签列表 */
  tags: string[]
  /** 创建时间戳（ms） */
  createdAt: number
  /** 最后更新时间戳（ms） */
  updatedAt: number
  /** 创建时当前活跃窗口标题（可选，用于追溯上下文） */
  windowTitle?: string
  /** 创建时当前活跃 AI 平台名（可选） */
  aiPlatform?: string
}

/** 笔记保存输入（upsert 语义：无 id 新增，有 id 更新） */
export interface NoteSaveInput {
  id?: string
  content?: string
  contentJson?: string
  title?: string
  pinned?: boolean
  tags?: string[]
  windowTitle?: string
  aiPlatform?: string
}
