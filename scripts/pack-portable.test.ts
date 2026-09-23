import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

describe('portable packaging process boundaries', () => {
  it('never invokes an image-wide process termination command', () => {
    const spawnSync = vi.fn(() => ({ status: 0 }))
    const source = fs.readFileSync(path.resolve('scripts/pack-portable.cjs'), 'utf8')
    const fixtureFs = {
      readFileSync: () => JSON.stringify({ version: '0.0.0' }),
      existsSync: (target: string) => target.endsWith('win-unpacked'),
      renameSync: vi.fn(),
    }
    try {
      vm.runInNewContext(source, {
        require: (name: string) => {
          if (name === 'fs' || name === 'node:fs') return fixtureFs
          if (name === 'path' || name === 'node:path') return path
          if (name === 'child_process' || name === 'node:child_process') return { spawnSync }
          throw new Error(`Fixture module boundary: ${name}`)
        },
        __dirname: path.resolve('scripts'),
        process: { platform: 'win32', exit: () => { throw new Error('Fixture exit') } },
        console: { log: vi.fn(), error: vi.fn(), warn: vi.fn() },
      })
    } catch { /* The fixture stops before filesystem packaging. */ }
    expect(spawnSync).toHaveBeenCalled()
    expect(spawnSync.mock.calls.some(call => call[0] === 'taskkill')).toBe(false)
  })
})
