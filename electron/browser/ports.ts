// electron/browser/ports.ts — 浏览器域实现对 L1 端口的装配
//
// application-main 在启动早期调用 installBrowserDomainPorts，随后 L1 的窗口、
// 安全与诊断服务才能通过 platform/browser-port.ts 读取浏览器数据。

import { installBrowserPorts } from '../platform/browser-port.js'
import { browserWindowStore } from './browser-window-store.js'
import { profileStore } from './profile-store.js'
import { presetStore } from './preset-store.js'
import { copySessionCookies } from './cookie-copy.js'
import { attachWebviewAntiDetection } from './webview-anti-detection.js'
import { attachWebviewHotkeyRouter } from './webview-hotkeys.js'
import { getRecordByWebContentsId } from './webview-registry.js'

export function installBrowserDomainPorts(): void {
  installBrowserPorts({
    profiles: profileStore,
    presets: presetStore,
    browserWindows: browserWindowStore,
    sessions: { copyCookies: copySessionCookies },
    webviews: { getRecordByWebContentsId },
    attach: {
      hotkeyRouter: attachWebviewHotkeyRouter,
      antiDetection: attachWebviewAntiDetection,
    },
  })
}
