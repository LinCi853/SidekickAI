// electron/window-factory/paths.ts — 路径工具
//
// 从 helpers.ts 抽离：__dirname / isDev / preload 路径获取。
//
// 注意：原 window-factory.ts 位于 electron/，__dirname 指向 electron/(dev)/out/main/(prod)。
// 现 helpers.ts 位于 electron/window-factory/，需向上回溯一层（path.resolve(..., '..')）
// 以保持 __dirname 语义与原文件一致，从而窗口文件中 path.join(__dirname, '../preload/...')
// 等路径无需修改。

import { app } from 'electron'
import path from 'path'

// CJS bundle（electron-vite 输出 format:'cjs'）下 __filename 是 Node 全局，
// 不再需要 import.meta.url / fileURLToPath 这一套 ESM 取路径的写法。
export const __dirname = path.dirname(__filename)

// 判断是否开发模式：使用 app.isPackaged 确保打包后判断准确
export const isDev = !app.isPackaged

// 获取 preload 脚本路径
// dev: out/preload/index.cjs（electron-vite 编译输出）
// prod: ../preload/index.cjs（与 main 同级目录）
export function getPreloadPath(): string {
  if (isDev) {
    return path.resolve(__dirname, '../preload/index.cjs')
  }
  return path.join(__dirname, '../preload/index.cjs')
}

// 获取 webview 访客页 preload 脚本路径
// 用于 webview 内的反检测覆盖（navigator.webdriver / chrome.runtime 等）
export function getWebviewPreloadPath(): string {
  if (isDev) {
    return path.resolve(__dirname, '../preload/webview.cjs')
  }
  return path.join(__dirname, '../preload/webview.cjs')
}
