import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // 与 electron.vite.config.ts / tsconfig paths 保持一致（渲染层测试会从 src/ 导入共享常量）
    alias: {
      '@shared': resolve(__dirname, 'electron/shared'),
    },
  },
  test: {
    // packages/** 的备份核心测试由 `npm run test:backup` 单独跑（`--root packages/backup-core`）：
    // 它们依赖 better-sqlite3 原生模块，而 CI 用 `npm ci --ignore-scripts` 不编译原生模块，
    // 直接并进 include 会让 CI 的 npm test 变红。
    include: ['electron/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}', 'scripts/*.test.ts'],
    exclude: ['**/node_modules/**', '**/local/**', '**/build/**', '**/release/**', '**/dist*/**'],
    // vitest 5 移除了 --minWorkers/--maxWorkers 命令行参数，worker 限额集中在此配置
    minWorkers: 1,
    maxWorkers: 4,
  },
})
