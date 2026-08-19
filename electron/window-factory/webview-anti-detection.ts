// electron/window-factory/webview-anti-detection.ts — webview 反检测
//
// 从 helpers.ts 抽离：为窗口的 webContents 注册 <webview> 反检测 preload 注入。

import { getWebviewPreloadPath } from './paths.js'

/**
 * 为窗口的 webContents 注册 <webview> 反检测 preload 注入。
 *
 * 通过 will-attach-webview 事件（webview 附加前触发），强制设置 preload 脚本，
 * 在页面脚本执行前覆盖 navigator.webdriver / window.chrome 等特征属性，
 * 防止 DeepSeek 等网站识别出 Electron/WebView 环境。
 */
export function attachWebviewAntiDetection(parentWebContents: Electron.WebContents): void {
  const webviewPreload = getWebviewPreloadPath()
  parentWebContents.on('will-attach-webview', (_event, webPreferences) => {
    webPreferences.preload = webviewPreload
    webPreferences.contextIsolation = true
    webPreferences.nodeIntegration = false
    webPreferences.sandbox = false
  })
}
