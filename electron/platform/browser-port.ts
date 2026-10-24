// electron/platform/browser-port.ts — 浏览器域端口（L1）
//
// 浏览器域（electron/browser/，L2）在应用装配阶段把实现注入到这里，
// 使 L1 的窗口、安全与诊断服务可以读取浏览器数据，而不反向依赖 L2。
// 装配必须先于读取：application-main 在启动早期调用 installBrowserPorts。

import type { Session, WebContents } from 'electron'
import type { BrowserWindowState, DevicePreset, Profile } from '../shared/types.js'
import type { WebviewRegistration } from '../shared/api/profile-window.api.js'

export interface BrowserProfilePort {
  get(id: string): Profile | null
}

export interface BrowserPresetPort {
  get(id: string): DevicePreset | null
}

export interface BrowserWindowStatePort {
  get(id: string): BrowserWindowState | null
}

export interface BrowserSessionPort {
  /** Copies every cookie from the main-window session to a browser-window session. */
  copyCookies(source: Session, target: Session): Promise<void>
}

export interface WebviewRecordPort {
  getRecordByWebContentsId(webContentsId: number): (WebviewRegistration & { registeredAt: number }) | null
}

export interface WebviewAttachPort {
  hotkeyRouter(webContents: WebContents, parentWebContents: WebContents, onCtrlKeyChange: (pressed: boolean) => void): void
  antiDetection(parentWebContents: WebContents): void
}

export interface BrowserPorts {
  profiles: BrowserProfilePort
  presets: BrowserPresetPort
  browserWindows: BrowserWindowStatePort
  sessions: BrowserSessionPort
  webviews: WebviewRecordPort
  attach: WebviewAttachPort
}

let ports: BrowserPorts | null = null

/** Installs the browser domain implementations; must run before any window creation. */
export function installBrowserPorts(value: BrowserPorts): void {
  ports = value
}

/** Resolves the installed ports, failing loudly when assembly skipped the installation. */
export function browserPorts(): BrowserPorts {
  if (!ports) throw new Error('Browser ports are not installed')
  return ports
}
