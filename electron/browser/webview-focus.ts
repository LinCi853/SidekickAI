// electron/browser/webview-focus.ts — 访客页焦点状态缓存
//
// webview-preload 在 focusin/focusout 时通过 sendSync 上报「焦点是否在可编辑元素」，
// 主进程按 guest webContents 缓存，供 before-input-event 在按键瞬间同步查询：
// 正在输入时，字符键（? / `）放行给页面输入，不作为应用快捷键拦截。
//
// sendSync 保证按键时刻读到的是当前焦点状态，无异步竞态。
// 契约：handler 必须设置 event.returnValue，否则渲染进程会永久阻塞（页面白屏）。
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'

const editableFocus = new WeakMap<Electron.WebContents, boolean>()
let installed = false

export function installWebviewFocusTracking(): void {
  if (installed) return
  installed = true
  ipcMain.on(IPC_CHANNELS.WEBVIEW_FOCUS_EDITABLE, (event, editable: unknown) => {
    editableFocus.set(event.sender, editable === true)
    // sendSync 要求同步应答；漏掉 returnValue 会卡死 guest 渲染进程
    event.returnValue = true
  })
}

/** 访客页焦点当前是否在可编辑元素（从未上报时视为否，保持原有拦截行为） */
export function isGuestFocusEditable(wc: Electron.WebContents): boolean {
  return editableFocus.get(wc) ?? false
}
