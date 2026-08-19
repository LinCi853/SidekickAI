import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// 空模块路径：用于 alias 排除不需要的传递依赖
const emptyMod = resolve(__dirname, 'src/lib/_empty.ts')

// electron-vite 配置：主进程 / preload / 渲染进程 三入口
export default defineConfig({
  main: {
    // 主进程入口（Electron Main Process）
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main.ts'),
        },
        // 主进程依赖由 externalizeDepsPlugin 外置，无需 manualChunks
      },
    },
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@main': resolve(__dirname, 'electron'),
        '@shared': resolve(__dirname, 'electron/shared'),
      },
    },
  },
  preload: {
    // Preload 脚本入口（contextBridge 暴露 API 到渲染进程）
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload.ts'),
          webview: resolve(__dirname, 'electron/webview-preload.ts'),
        },
      },
    },
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    // 渲染进程（React UI），复用现有 src/ 目录
    root: 'src',
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/index.html'),
        },
        output: {
          // 渲染层按依赖拆分 chunk：避免单文件过大 + 提升缓存命中
          manualChunks: {
            'vendor-react': ['react', 'react-dom'],
            'vendor-excalidraw': ['@excalidraw/excalidraw'],
            'vendor-highlight': ['highlight.js'],
            'vendor-markdown': ['react-markdown', 'remark-gfm', 'rehype-highlight'],
          },
        },
      },
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@components': resolve(__dirname, 'src/components'),
        '@hooks': resolve(__dirname, 'src/hooks'),
        '@lib': resolve(__dirname, 'src/lib'),
        '@store': resolve(__dirname, 'src/store'),
        '@styles': resolve(__dirname, 'src/styles'),
        // ── 构建噪音优化 ──────────────────────────────────
        // mermaid / katex 是 @excalidraw/excalidraw 的传递依赖，
        // 但源码从未 import mermaid（不使用 Mermaid→Excalidraw 转换功能）。
        // 映射到空模块可从渲染层 bundle 中剔除 ~5-8 MB 的图表引擎 + 51 个 locale 文件。
        'mermaid': emptyMod,
        'katex': emptyMod,
      },
    },
    server: {
      port: 5173,
    },
  },
})
