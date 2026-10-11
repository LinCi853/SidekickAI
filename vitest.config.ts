import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['electron/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}', 'scripts/*.test.ts'],
    exclude: ['**/node_modules/**', '**/local/**', '**/build/**', '**/release/**', '**/dist*/**'],
    // vitest 5 移除了 --minWorkers/--maxWorkers 命令行参数，worker 限额集中在此配置
    minWorkers: 1,
    maxWorkers: 4
  }
})
