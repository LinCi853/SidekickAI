// electron/store/store-paths.ts — store 层公共路径工具
//
// 抽取各 store 文件重复的 __dirname 与 STORE_CWD 计算，统一路径策略：
//   - dev 模式（ELECTRON_RENDERER_URL 存在）：写入项目内 .app-data/
//   - 生产便携版（exe 同级存在 portable.txt）：写入 exe 同级 data/ 目录
//   - 生产安装版：使用 electron-store 默认 userData 路径（cwd 传 undefined）
//
// 关键：getStoreCwd() 必须独立检测便携模式，不能依赖 main.ts 的
// redirectUserData()，因为 ESM import 阶段 store 就已初始化，早于
// redirectUserData() 顶层调用。否则便携版数据会误写入系统目录。

import path from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import { app } from 'electron'

/** 等价于 CommonJS __dirname，用于 ESM 获取当前模块目录 */
export function getModuleDirname(): string {
  return path.dirname(fileURLToPath(import.meta.url))
}

/**
 * 便携模式检测：exe 同级目录是否存在 portable.txt
 * 在 dev 模式下始终返回 false。
 */
let _portableCache: boolean | null = null
export function isPortableMode(): boolean {
  if (_portableCache !== null) return _portableCache
  // dev 模式不是便携版
  if (process.env.ELECTRON_RENDERER_URL) {
    _portableCache = false
    return false
  }
  try {
    const exePath = app.getPath('exe')
    const exeDir = path.dirname(exePath)
    const portableMarker = path.join(exeDir, 'portable.txt')
    _portableCache = existsSync(portableMarker)
  } catch {
    _portableCache = false
  }
  return _portableCache
}

/**
 * store 文件存储根目录：
 *   - dev 模式：项目内 .app-data/
 *   - 生产便携版：exe 同级 data/ 目录（数据跟随 exe 移动）
 *   - 生产安装版：undefined（electron-store 使用默认 userData 路径）
 */
export function getStoreCwd(): string | undefined {
  // dev 模式
  if (process.env.ELECTRON_RENDERER_URL) {
    return path.join(getModuleDirname(), '..', '..', '.app-data')
  }
  // 生产便携模式
  if (isPortableMode()) {
    const exePath = app.getPath('exe')
    const exeDir = path.dirname(exePath)
    return path.join(exeDir, 'data')
  }
  // 生产安装版：用 electron-store 默认
  return undefined
}
