import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const tauriApiPath = fileURLToPath(new URL('../installer-tauri/node_modules/@tauri-apps/api', import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@tauri-apps/api': tauriApiPath,
    },
  },
  clearScreen: false,
  base: './',
  server: {
    port: 1421,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    target: 'chrome105',
    minify: true,
    sourcemap: false,
  },
})
