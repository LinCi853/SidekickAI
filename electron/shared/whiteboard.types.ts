// whiteboard.types.ts — 白板 AI 窗口数据类型（需求 12）
// 主进程 / Preload / 渲染进程共享，避免循环依赖。

/** 卡片类型 */
export type WhiteboardCardType = 'text' | 'image' | 'ai-reply'

/** 白板卡片（文本 / 图片 / AI 回复） */
export interface WhiteboardCard {
  /** 唯一 id（UUID） */
  id: string
  /** 卡片类型：text=文本 / image=图片 / ai-reply=AI 回复 markdown */
  type: WhiteboardCardType
  /** 画布坐标 x（左上角，画布坐标系，非视口坐标） */
  x: number
  /** 画布坐标 y（左上角，画布坐标系） */
  y: number
  /** 卡片宽度（可选，未指定时由内容撑开） */
  width?: number
  /** 卡片高度（可选，未指定时由内容撑开） */
  height?: number
  /** 卡片内容：text=纯文本 / image=dataURL / ai-reply=markdown */
  content: string
  /** 元数据（可选，用于追溯来源） */
  metadata?: {
    /** 来源 URL（截图网页时记录） */
    sourceUrl?: string
    /** 来源 AI 平台名（AI 回复卡片） */
    platform?: string
    /** 创建时间戳（ms） */
    createdAt?: number
  }
}

/** 卡片间箭头连接 */
export interface WhiteboardArrow {
  /** 唯一 id（UUID） */
  id: string
  /** 起点卡片 id */
  fromCardId: string
  /** 终点卡片 id */
  toCardId: string
}

/** 手绘线条（自由绘制） */
export interface WhiteboardStroke {
  /** 唯一 id（UUID） */
  id: string
  /** 路径点序列（画布坐标系） */
  points: Array<{ x: number; y: number }>
  /** 颜色（默认使用主题色） */
  color?: string
  /** 线宽（默认 2） */
  width?: number
}

/** 白板视口（平移 + 缩放） */
export interface WhiteboardViewport {
  x: number
  y: number
  zoom: number
}

/** 完整白板状态 */
export interface WhiteboardState {
  cards: WhiteboardCard[]
  arrows: WhiteboardArrow[]
  strokes: WhiteboardStroke[]
  viewport: WhiteboardViewport
}

/** 卡片新增/更新输入（id/x/y 可选；x/y 未提供时由主进程随机生成） */
export type WhiteboardCardInput = Omit<WhiteboardCard, 'id' | 'x' | 'y'>
  & Partial<Pick<WhiteboardCard, 'id' | 'x' | 'y'>>
