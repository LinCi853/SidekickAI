import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// electron-vite 配置：主进程 / preload / 渲染进程 三入口
export default defineConfig({
  main: {
    // 主进程入口（Electron Main Process）
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main.ts'),
        },
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
      },
    },
    server: {
      port: 5173,
    },
  },
})
