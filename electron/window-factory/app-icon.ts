// electron/window-factory/app-icon.ts — 应用窗口图标解析
//
// Windows 任务栏显示的是窗口 HICON。路径错误或空 NativeImage 会让任务栏
// 变成系统默认的白色文档图标（窗口存在时就会如此，与是否最小化无关）。
//
// 注意：以 electron out/main/index.cjs 启动时，app.getAppPath() 是 out/main
// 而不是仓库根；必须向上查找 resources/icons，不能只拼 getAppPath()。

import { app, nativeImage, type BrowserWindow, type NativeImage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

let cached: NativeImage | null | undefined
let cachedSource: string | null
let logged = false

function preferredNames(): string[] {
  return process.platform === 'win32' ? ['icon.ico', 'icon.png'] : ['icon.png', 'icon.ico']
}

/** 从 start 目录向上查找含 resources/icons 的应用根。 */
function walkUpForIcons(start: string, depth = 6): string[] {
  const found: string[] = []
  let dir = start
  for (let i = 0; i <= depth; i++) {
    const iconsDir = path.join(dir, 'resources', 'icons')
    if (fs.existsSync(iconsDir)) found.push(dir)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return found
}

function candidateIconFiles(): string[] {
  const files: string[] = []
  const seen = new Set<string>()
  const add = (file: string) => {
    const normalized = path.normalize(file)
    if (seen.has(normalized)) return
    seen.add(normalized)
    files.push(normalized)
  }

  const roots: string[] = []
  if (app.isPackaged && process.resourcesPath) {
    candidateFromRoot(process.resourcesPath).forEach(add)
    roots.push(process.resourcesPath)
  }
  try {
    roots.push(app.getAppPath())
  } catch { /* app not ready in some tests */ }
  roots.push(__dirname)
  try {
    roots.push(process.cwd())
  } catch { /* ignore */ }

  for (const root of roots) {
    for (const file of candidateFromRoot(root)) add(file)
    for (const found of walkUpForIcons(root)) {
      for (const file of candidateFromRoot(found)) add(file)
    }
  }
  return files
}

function candidateFromRoot(root: string): string[] {
  const files: string[] = []
  for (const name of preferredNames()) {
    files.push(path.join(root, 'resources', 'icons', name))
    files.push(path.join(root, 'icons', name))
    files.push(path.join(root, 'resources', name))
    files.push(path.join(root, name))
  }
  return files
}

/** 从 PNG 构建多尺寸 HICON，任务栏小图比单尺寸 ICO 更稳。 */
function imageFromPngFile(file: string): NativeImage | null {
  if (!/\.png$/i.test(file)) return null
  try {
    const base = nativeImage.createFromPath(file)
    if (base.isEmpty()) return null
    const composed = nativeImage.createEmpty()
    for (const size of [16, 24, 32, 48, 64, 128, 256]) {
      const resized = base.resize({ width: size, height: size, quality: 'best' })
      composed.addRepresentation({
        width: size,
        height: size,
        scaleFactor: size >= 32 ? 2 : 1,
        buffer: resized.toPNG(),
      })
    }
    return composed.isEmpty() ? base : composed
  } catch {
    return null
  }
}

function loadIconImage(file: string): NativeImage | null {
  try {
    if (!fs.existsSync(file)) return null
    const fromPng = imageFromPngFile(file)
    if (fromPng && !fromPng.isEmpty()) return fromPng
    const image = nativeImage.createFromPath(file)
    return image.isEmpty() ? null : image
  } catch {
    return null
  }
}

/** 解析并缓存应用窗口图标；找不到有效图像时返回 undefined。 */
export function getAppWindowIcon(): NativeImage | undefined {
  // 失败不永久缓存：下次创建窗口仍可重试（例如晚到的 resources 挂载）
  if (cached) return cached
  for (const file of candidateIconFiles()) {
    const image = loadIconImage(file)
    if (image) {
      cached = image
      cachedSource = file
      if (!logged) {
        logged = true
        console.log(`[app-icon] window icon loaded: ${file}`)
      }
      return image
    }
  }
  if (!logged) {
    logged = true
    console.warn('[app-icon] window icon NOT found; taskbar may show a blank document icon')
  }
  return undefined
}

/** 供测试/诊断：列出将要尝试的图标路径。 */
export function listWindowIconCandidates(): string[] {
  return candidateIconFiles()
}

/** 供测试/诊断：已加载图标文件。 */
export function getLoadedWindowIconSource(): string | null {
  return cachedSource
}

/**
 * 重新应用窗口图标。
 * 构造参数未生效或 Windows 无边框窗口在 minimize/restore 后丢失 HICON 时补设。
 */
export function reapplyWindowIcon(win: BrowserWindow | null | undefined): void {
  if (!win || win.isDestroyed() || process.platform !== 'win32') return
  const icon = getAppWindowIcon()
  if (!icon) return
  try {
    win.setIcon(icon)
  } catch {
    // 窗口可能正在销毁
  }
}
