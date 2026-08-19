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
import { fileURLToPath } from 'url'

// electron-vite 将所有 main 进程代码打包到 out/main/index.js，
// import.meta.url 指向该文件，故 __dirname = out/main（与 main.ts 一致）。
// 注意：开发模式下 helpers.ts 位于 electron/window-factory/，但 electron-vite
// 会将 import.meta.url 映射到 out/main/index.js，所以无需手动回溯。
export const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 判断是否开发模式：使用 app.isPackaged 确保打包后判断准确
export const isDev = !app.isPackaged

// 获取 preload 脚本路径
// dev: out/preload/index.mjs（electron-vite 编译输出）
// prod: ../preload/index.mjs（与 main 同级目录）
export function getPreloadPath(): string {
  if (isDev) {
    return path.resolve(__dirname, '../preload/index.mjs')
  }
  return path.join(__dirname, '../preload/index.mjs')
}

// 获取 webview 访客页 preload 脚本路径
// 用于 webview 内的反检测覆盖（navigator.webdriver / chrome.runtime 等）
export function getWebviewPreloadPath(): string {
  if (isDev) {
    return path.resolve(__dirname, '../preload/webview.mjs')
  }
  return path.join(__dirname, '../preload/webview.mjs')
}
