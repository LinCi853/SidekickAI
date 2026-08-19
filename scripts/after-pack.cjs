// scripts/after-pack.cjs
// electron-builder afterPack 钩子：
//   1. 删除 Chromium 自带的 LICENSES.chromium.html（10MB+）
//   2. 白板依赖：解析符号链接重拷贝（pnpm 的 symlink 导致 NSIS 7z 无法跟踪）
//   3. 删除 electron-builder 生成的调试文件（builder-debug.yml 等）
const fs = require('fs')
const path = require('path')

/**
 * @param {import('electron-builder').AfterPackContext} context
 */
module.exports = function afterPack(context) {
  const appOutDir = context.appOutDir
  // 安装包/便携版输出目录的父级（即 dist/ 或 dist-portable/）
  const distDir = path.dirname(appOutDir)

  // ── 1. 删除 appOutDir 内的无用文件 ──
  const appTargets = [
    'LICENSES.chromium.html',
    'LICENSE.electron.txt',
  ]

  for (const name of appTargets) {
    const full = path.join(appOutDir, name)
    if (fs.existsSync(full)) {
      try {
        fs.unlinkSync(full)
        console.log(`[after-pack] 已删除 ${name}`)
      } catch (err) {
        console.warn(`[after-pack] 删除 ${name} 失败:`, err.message)
      }
    }
  }

  // ── 2. 白板依赖：解析符号链接重拷贝（pnpm 的 symlink 导致 NSIS 7z 无法跟踪） ──
  const whiteboardDepsDir = path.join(appOutDir, 'resources', 'plugins', 'whiteboard', 'deps')
  const nodeModulesDir = path.join(process.cwd(), 'node_modules')
  const whiteboardDeps = [
    { src: '@excalidraw', dest: '@excalidraw' },
    { src: 'mermaid', dest: 'mermaid' },
    { src: 'katex', dest: 'katex' },
  ]
  for (const dep of whiteboardDeps) {
    const srcDir = path.join(nodeModulesDir, dep.src)
    const destDir = path.join(whiteboardDepsDir, dep.dest)
    if (!fs.existsSync(srcDir)) {
      console.log('[after-pack] 白板依赖 ' + dep.src + ' 不存在，跳过')
      continue
    }
    // 删除 extraResources 拷贝的符号链接目录（如果有）
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true })
    }
    fs.mkdirSync(path.dirname(destDir), { recursive: true })
    // dereference:true 解析符号链接，拷贝实际文件（不再有 junction/symlink）
    fs.cpSync(srcDir, destDir, { recursive: true, dereference: true })
    console.log('[after-pack] 已复制白板依赖 ' + dep.src + '（符号链接已解析）')
  }

  // ── 3. 删除 dist 目录中的 electron-builder 调试/元数据文件 ──
  const distTargets = [
    'builder-debug.yml',
    'builder-effective-config.yaml',
  ]

  for (const name of distTargets) {
    const full = path.join(distDir, name)
    if (fs.existsSync(full)) {
      try {
        fs.unlinkSync(full)
        console.log(`[after-pack] 已删除 ${name}`)
      } catch (err) {
        console.warn(`[after-pack] 删除 ${name} 失败:`, err.message)
      }
    }
  }
}
