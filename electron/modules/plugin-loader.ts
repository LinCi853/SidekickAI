// electron/modules/plugin-loader.ts — 插件发现与加载
//
// 使用 Vite 的 import.meta.glob 在编译时静态发现 plugins/ 子目录中的 manifest.ts。
// Rollup 会将所有匹配文件打包到输出中，确保 dev 和 production 行为一致。
// 第一方插件（TypeScript，编译时集成）使用此加载器；第三方外部插件（Phase 2）暂不实现。
// 设计规范见 docs/功能插件系统与安装管控方案.md。

import type { ModuleManifest } from '../shared/module-manifest.types.js'

// Vite/Rollup 在编译时静态分析此 glob，所有匹配文件会被打包到输出中。
// 第一方插件只需在 plugins/ 下建目录 + manifest.ts，无需修改任何配置。
const pluginManifestGlob = import.meta.glob<{ default: ModuleManifest }>(
  './plugins/*/manifest.ts',
  { eager: false },
)

/**
 * 加载内置插件 manifests（electron/modules/plugins/）。
 * 每个子目录必须包含 manifest.ts（default export 为 ModuleManifest）。
 */
export async function loadBuiltinPlugins(): Promise<ModuleManifest[]> {
  const manifests: ModuleManifest[] = []
  for (const [filePath, importFn] of Object.entries(pluginManifestGlob)) {
    try {
      const mod = await importFn()
      const manifest = mod.default
      if (manifest && typeof manifest.id === 'string') {
        manifests.push(manifest)
        console.log(`[plugin-loader] 已加载内置插件: ${manifest.id}`)
      }
    } catch (err) {
      console.warn(`[plugin-loader] 加载插件失败 (${filePath}):`, err)
    }
  }
  return manifests
}
