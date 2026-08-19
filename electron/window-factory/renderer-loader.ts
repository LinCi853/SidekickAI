// electron/window-factory/renderer-loader.ts — 渲染进程加载
//
// 从 helpers.ts 抽离：渲染进程 URL 构建、浏览器窗口判断、页面加载。

import { BrowserWindow } from 'electron'
import path from 'path'
import { windowState } from '../window-state.js'
import { __dirname } from './paths.js'

/**
 * 构建渲染进程加载 URL（附加 windowId 查询参数，可选 mode + extraQuery）
 */
function buildRendererUrl(
  windowId: string,
  mode?: string,
  extraQuery?: Record<string, string>,
): string {
  if (process.env.ELECTRON_RENDERER_URL) {
    const sep = process.env.ELECTRON_RENDERER_URL.includes('?') ? '&' : '?'
    const params = new URLSearchParams({ windowId })
    if (mode) params.set('mode', mode)
    if (extraQuery) {
      for (const [k, v] of Object.entries(extraQuery)) params.set(k, v)
    }
    return `${process.env.ELECTRON_RENDERER_URL}${sep}${params.toString()}`
  }
  // 生产环境通过 loadFile 的 query 选项传递
  return '' // 空字符串表示用 loadFile
}

/**
 * 判断 webContents 是否属于浏览器窗口。
 * 双保险：webContents 标记（loadRenderer 写入，不依赖 URL）+ URL 兜底。
 */
export function isBrowserWindowContents(wc: Electron.WebContents): boolean {
  try {
    const tagged = (wc as unknown as { __aiWindowMode?: string }).__aiWindowMode
    if (tagged === 'browser') return true
    if (tagged === 'main') return false
  } catch { /* ignore */ }
  return (wc.getURL?.() || '').includes('mode=browser')
}

/**
 * 加载渲染进程页面（dev server 或打包文件）
 */
export function loadRenderer(
  win: BrowserWindow,
  windowId: string,
  mode?: string,
  extraQuery?: Record<string, string>,
): void {
  // 窗口类型标记：主进程快捷键路由不再依赖 URL 解析（dev/生产一致）
  try {
    (win.webContents as unknown as { __aiWindowMode?: string }).__aiWindowMode = mode ?? 'main'
  } catch { /* ignore */ }
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(buildRendererUrl(windowId, mode, extraQuery))
  } else {
    const query: Record<string, string> = { windowId }
    if (mode) query.mode = mode
    if (extraQuery) Object.assign(query, extraQuery)
    void win.loadFile(path.join(__dirname, '../renderer/index.html'), {
      query,
    })
  }
  // --dev-tools 模式：窗口加载后自动打开 DevTools
  if (windowState.autoOpenDevTools) {
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed()) win.webContents.openDevTools({ mode: 'detach' })
    })
  }
}
