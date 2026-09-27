import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  resolve: {
    alias: { '@tauri-apps/api': fileURLToPath(new URL('../installer-tauri/node_modules/@tauri-apps/api', import.meta.url)) },
  },
  test: {
    include: [
      'installer-shared/uninstall/*.test.ts',
      'installer-shared/on-demand/*.test.ts',
    ],
    environment: 'node',
  },
})
