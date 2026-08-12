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

/** 文本层单项：文本 + 文档坐标（CSS 像素，相对文档左上角） */
export interface TextLayerItem {
  text: string
  x: number
  y: number
  w: number
  h: number
}

/** 冻结时提取的文本层（供渲染层选择层做选中/复制） */
export interface TextLayer {
  items: TextLayerItem[]
  /** 冻结瞬间页面垂直滚动偏移（视口坐标 = 文档坐标 - scrollOffsetY - 用户滚轮累计） */
  scrollOffsetY: number
  /** 页面内容总高度（判断滚动边界用） */
  contentHeight: number
  viewportHeight: number
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
  freezeTab: (payload: { tabId: string; profileId: string }) => Promise<{
    frozen: boolean
    snapshot: FreezeSnapshot | null
    textLayer: TextLayer | null
  }>
  /** 恢复指定 tab（解除冻结） */
  resume: (tabId: string) => Promise<boolean>
  /** 彻底分离调试器 */
  detach: (tabId: string) => Promise<boolean>
  /** 查询冻结状态 */
  status: (tabId: string) => Promise<FreezeState>
  /** 主→渲染：冻结状态变化推送 */
  onStateChanged: (callback: (payload: { tabId: string; state: FreezeState }) => void) => () => void
  /** 渲染→主：冻结态滚轮转发（选择层滚轮 → guest compositor 滚动画面） */
  scroll: (payload: { tabId: string; deltaX: number; deltaY: number }) => void
  /** 渲染→主：冻结态应用内置复制（选中文本 → 主进程写系统剪贴板） */
  copyText: (text: string) => void
}
