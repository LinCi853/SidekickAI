// scripts/after-pack.cjs
// electron-builder afterPack 钩子：
//   1. 删除 Chromium 自带的 LICENSES.chromium.html（10MB+）
//   2. 白板依赖：解析 pnpm 符号链接后拷贝（可选组件，约 140MB）
//   3. 删除 electron-builder 生成的调试文件（builder-debug.yml 等）
// 注意：白板 deps 不走 extraResources——pnpm 的相对符号链接会以断链形式进包，
// 必须在打包后用 realpath 解析到 .pnpm 真实路径再拷贝。
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

  // ── 2. 删除白板依赖死目录（约 134MB）──
  // 此前会把 @excalidraw/excalidraw、mermaid、katex 完整拷到
  // resources/plugins/whiteboard/deps（约 134MB）。但：
  //   - WhiteboardView.tsx 直接 import '@excalidraw/excalidraw'，已由 Vite 打进
  //     vendor-excalidraw chunk（~1.9MB）；
  //   - electron.vite.config.ts 已将 mermaid/katex 别名成空模块（源码从不 import）；
  //   - 全代码库无任何地方引用 plugins/whiteboard/deps 路径。
  // 故这 134MB 属死代码，构建后彻底删除（安装体积 500MB → ~360MB+）。
  const whiteboardDeps = path.join(appOutDir, 'resources', 'plugins', 'whiteboard', 'deps')
  if (fs.existsSync(whiteboardDeps)) {
    try {
      fs.rmSync(whiteboardDeps, { recursive: true, force: true })
      console.log('[after-pack] 已删除白板死依赖目录 resources/plugins/whiteboard/deps')
      // 若 whiteboard 目录已空，一并删除
      const whiteboardDir = path.dirname(whiteboardDeps)
      if (fs.existsSync(whiteboardDir) && fs.readdirSync(whiteboardDir).length === 0) {
        fs.rmSync(whiteboardDir, { recursive: true, force: true })
        console.log('[after-pack] 已删除空目录 resources/plugins/whiteboard')
      }
    } catch (err) {
      console.warn('[after-pack] 删除白板死依赖失败:', err.message)
    }
  }

  // ── 2.1 删除 asar 内残留的渲染层死依赖（约 132MB）──
  // mermaid / @excalidraw / katex / @tiptap 等仅被渲染层 import，已由 Vite 打包进
  // 渲染层 bundle；主进程/preload 从不 require 它们。但 electron-builder 默认会把
  // package.json 的 dependencies 整包塞进 app.asar，造成重复体积。
  // 这里在解包的 appOutDir 侧无法直接清理 asar 内部，需配合 yml 的 files 排除
  // （electron-builder.yml / electron-builder.portable.yml 中的 !node_modules/...）。
  // 若配置遗漏导致仍进包，下面兜底清理 app.asar 外已解包的同名目录。
  const asarUnpackedNode = path.join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules')
  if (fs.existsSync(asarUnpackedNode)) {
    for (const dead of ['mermaid', '@excalidraw', 'katex', '@tiptap']) {
      const p = path.join(asarUnpackedNode, dead)
      if (fs.existsSync(p)) {
        try {
          fs.rmSync(p, { recursive: true, force: true })
          console.log(`[after-pack] 已删除 app.asar.unpacked 死依赖: ${dead}`)
        } catch (err) {
          console.warn(`[after-pack] 删除 ${dead} 失败:`, err.message)
        }
      }
    }
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
