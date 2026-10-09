import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['electron/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}', 'scripts/*.test.ts'],
    exclude: ['**/node_modules/**', '**/local/**', '**/build/**', '**/release/**', '**/dist*/**']
  }
})
