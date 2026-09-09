import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Tauri 前端构建配置（与 forgelite 模板一致）
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // 关键：生产模式产物用相对路径，否则 Tauri (tauri://localhost) 下资源从根解析不到，
  // 出现「无法访问此页面」。dev 模式 Tauri 内置服务器会自动处理。
  base: process.env.TAURI_ENV_PLATFORM ? './' : '/',
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**']
    }
  },
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG
  }
})
