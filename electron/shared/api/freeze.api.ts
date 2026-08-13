// electron/shared/api/freeze.api.ts — 页面冻结 API 类型（防撤回保险）

/** 冻结时抓取的对话快照 */
export interface FreezeSnapshot {
  pairs: Array<{ user: string; assistant: string }>
  title: string
  url: string
  scrapedAt: number
}

/** 冻结状态 */
export type FreezeState = 'idle' | 'attached' | 'frozen'

/** 单个 grapheme 的真实 guest 视口边界（CSS px） */
export interface TextLayerGrapheme {
  text: string
  start: number
  end: number
  x: number
  y: number
  w: number
  h: number
  line: number
}

/** 一行视觉文本 run：包含真实字符边界与完整排版样式 */
export interface TextLayerItem {
  text: string
  x: number
  y: number
  w: number
  h: number
  line: number
  /** DOM 块边界或显式换行位于该 run 之前；视觉软换行不设置 */
  breakBefore?: boolean
  transformed?: boolean
  verticalWriting?: boolean
  viewportFixed?: boolean
  sticky?: boolean
  direction?: string
  /** 主路径保存的真实 grapheme 边界；降级路径为空 */
  graphemes?: TextLayerGrapheme[]
}

/** 冻结时提取的文本层；坐标统一为 guest visual viewport CSS px */
export interface TextLayer {
  version: 2
  coordinateSpace: 'guest-visual-viewport-css-px-v2'
  items: TextLayerItem[]
  scrollOffsetX: number
  scrollOffsetY: number
  contentWidth: number
  contentHeight: number
  viewportWidth: number
  viewportHeight: number
  visualScale: number
  devicePixelRatio: number
  quality: 'glyph' | 'domsnapshot' | 'none'
  truncated: boolean
}

export interface FreezeActionResult {
  frozen: boolean
  state: FreezeState
  revision: number
  snapshot: FreezeSnapshot | null
  textLayer: TextLayer | null
}

export interface FreezeScrollResult {
  scrollOffsetX: number
  scrollOffsetY: number
}

/** 页面冻结 API（防撤回保险：Debugger.pause 冻结 webview + 文本层应用内选中复制） */
export interface FreezeAPI {
  /** 注册 webview 到冻结注册表（webview attach 后调用） */
  registerWebview: (payload: {
    tabId: string
    windowId: string
    profileId: string
    webContentsId: number
  }) => Promise<boolean>
  /** 冻结指定 tab（先抓取对话入库 + 提取文本层再 pause，返回冻结结果 + 快照 + 文本层） */
  freezeTab: (payload: { tabId: string; profileId: string }) => Promise<FreezeActionResult>
  /** 按主进程真实状态冻结或恢复，避免渲染层缓存状态竞态 */
  toggle: (payload: { tabId: string; profileId: string }) => Promise<FreezeActionResult>
  /** 恢复指定 tab（解除冻结） */
  resume: (tabId: string) => Promise<boolean>
  /** 彻底分离调试器 */
  detach: (tabId: string) => Promise<boolean>
  /** 查询冻结状态 */
  status: (tabId: string) => Promise<FreezeState>
  /** 主→渲染：冻结状态变化推送 */
  onStateChanged: (callback: (payload: { tabId: string; state: FreezeState; revision: number }) => void) => () => void
  /** 渲染→主：冻结态滚轮转发（选择层滚轮 → guest compositor 滚动画面） */
  scroll: (payload: { tabId: string; x: number; y: number; deltaX: number; deltaY: number }) => Promise<FreezeScrollResult | null>
  /** 渲染→主：冻结态应用内置复制（选中文本 → 主进程写系统剪贴板） */
  copyText: (text: string) => void
}
