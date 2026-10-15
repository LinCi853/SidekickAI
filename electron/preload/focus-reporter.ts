// electron/preload/focus-reporter.ts — 访客页焦点状态上报
//
// focusin/focusout 时通过 sendSync 把「焦点是否在可编辑元素」同步给主进程，
// 供 before-input-event 在按键瞬间同步查询（无异步竞态）：
// 正在输入时，字符键（? / `）放行给页面输入，不作为应用快捷键拦截。

import { ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'

// IFRAME/OBJECT/EMBED：焦点进入内嵌文档时顶层无法得知内部状态，按可能可编辑放行
const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'IFRAME', 'OBJECT', 'EMBED'])

function isEditableFocus(): boolean {
  const target = document.activeElement
  if (!(target instanceof HTMLElement) || target === document.body) return false
  return target.isContentEditable || EDITABLE_TAGS.has(target.tagName)
}

export function installFocusReporter(): void {
  const report = () => {
    try { ipcRenderer.sendSync(IPC_CHANNELS.WEBVIEW_FOCUS_EDITABLE, isEditableFocus()) }
    catch { /* 通道未就绪时忽略 */ }
  }
  window.addEventListener('focusin', report, true)
  // focusout 先于新目标的 focusin 触发，延后一拍上报最终落点
  window.addEventListener('focusout', () => { setTimeout(report, 0) }, true)
  report()
}
