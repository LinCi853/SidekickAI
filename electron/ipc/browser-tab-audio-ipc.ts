// electron/ipc/browser-tab-audio-ipc.ts — 浏览器标签音频 IPC（v0.0.9）
//
// 当前实现：webview 的 media-started-playing / media-paused 事件可在渲染层
// 直接监听（BrowserWebviewTab.tsx），setAudioMuted 也是 webview DOM 方法可直接调用。
// 因此本文件仅作为跨窗口音频状态同步的预留入口，当前无 handler 注册。
//
// 未来扩展：若需在标签管理面板（跨窗口）显示其他窗口标签的 audible 状态，
// 可在此文件注册 BROWSER_TAB_AUDIO_CHANGED 的主进程广播逻辑。

import type { BrowserWindow } from 'electron'

export interface BrowserTabAudioIpcDeps {
  /** 获取所有浏览器窗口（用于跨窗口广播音频状态） */
  getAllBrowserWindows?: () => BrowserWindow[]
}

/** 注册浏览器标签音频相关 IPC（当前为预留，无 handler） */
export function registerBrowserTabAudioIpc(_deps: BrowserTabAudioIpcDeps): void {
  // 预留：当前音频事件在渲染层直接处理，无需主进程桥接。
  // 若后续需要跨窗口广播 audible 状态，可在此注册。
}
