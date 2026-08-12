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

/** 页面冻结 API（防撤回保险：Debugger.pause 冻结 webview） */
export interface FreezeAPI {
  /** 注册 webview 到冻结注册表（webview attach 后调用） */
  registerWebview: (payload: {
    tabId: string
    windowId: string
    profileId: string
    webContentsId: number
  }) => Promise<boolean>
  /** 冻结指定 tab（先抓取对话入库再 pause，返回冻结结果 + 快照） */
  freezeTab: (payload: {
    tabId: string
    profileId: string
    /** webview 在窗口内的位置（CSS 像素）+ dpr，用于冻结态点击命中检测 */
    rect?: { x: number; y: number; width: number; height: number }
    dpr?: number
  }) => Promise<{
    frozen: boolean
    snapshot: FreezeSnapshot | null
  }>
  /** 恢复指定 tab（解除冻结） */
  resume: (tabId: string) => Promise<boolean>
  /** 彻底分离调试器 */
  detach: (tabId: string) => Promise<boolean>
  /** 查询冻结状态 */
  status: (tabId: string) => Promise<FreezeState>
  /** 主→渲染：冻结状态变化推送 */
  onStateChanged: (callback: (payload: { tabId: string; state: FreezeState }) => void) => () => void
  /** 主→渲染：窗口 move/resize 后请求重新上报冻结 tab 的 webview 位置 */
  onSyncRect: (callback: (payload: { tabIds: string[] }) => void) => () => void
  /** 渲染→主：上报 webview 位置（窗口内 CSS 像素 + dpr） */
  reportRect: (payload: {
    tabId: string
    rect: { x: number; y: number; width: number; height: number }
    dpr: number
  }) => void
}
