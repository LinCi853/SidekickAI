// electron/window-factory/web-preferences.ts — 统一 webPreferences 配置
//
// 从 helpers.ts 抽离：所有窗口共享的 webPreferences 默认配置块。

import { type WebPreferences } from 'electron'

/**
 * 构建统一的 webPreferences 配置块。
 * 所有窗口共享 contextIsolation / nodeIntegration / sandbox / backgroundThrottling 默认值，
 * 各窗口通过 opts 指定 preload 路径与 webviewTag 开关。
 * 若需额外字段（如 additionalArguments），调用方可展开后覆盖。
 */
export function createDefaultWebPreferences(opts: {
  preload: string
  webviewTag?: boolean
}): WebPreferences {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    backgroundThrottling: false,
    webviewTag: opts.webviewTag ?? false,
    preload: opts.preload,
  }
}
