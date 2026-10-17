// electron/window-factory/app-icon.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest'

const fixture = vi.hoisted(() => ({
  exists: true,
  empty: false,
  lastPath: '' as string,
  setIcon: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => 'E:/SidekickAI/out/main' },
  nativeImage: {
    createFromPath: (file: string) => {
      fixture.lastPath = file
      return { isEmpty: () => fixture.empty }
    },
  },
}))

vi.mock('node:fs', () => ({
  default: {
    existsSync: (p: string) => {
      // emulate repo layout: only E:/SidekickAI/resources/icons/icon.ico exists
      const normalized = String(p).replace(/\\/g, '/')
      return fixture.exists && normalized.endsWith('SidekickAI/resources/icons/icon.ico')
    },
  },
}))

describe('app-icon', () => {
  beforeEach(() => {
    fixture.exists = true
    fixture.empty = false
    fixture.lastPath = ''
    fixture.setIcon.mockClear()
    vi.resetModules()
  })

  it('finds the repo icon even when getAppPath is out/main', async () => {
    const mod = await import('./app-icon')
    const icon = mod.getAppWindowIcon()
    expect(icon).toBeTruthy()
    expect(fixture.lastPath.replace(/\\/g, '/')).toContain('resources/icons/icon.ico')
    // walk-up must discover the repository root above out/main
    const candidates = mod.listWindowIconCandidates().map(p => p.replace(/\\/g, '/'))
    expect(candidates.some(p => p.includes('SidekickAI/resources/icons/icon.ico'))).toBe(true)
  })

  it('returns undefined when every candidate is empty', async () => {
    fixture.empty = true
    const mod = await import('./app-icon')
    expect(mod.getAppWindowIcon()).toBeUndefined()
  })

  it('reapplies the icon for live Windows windows only', async () => {
    const mod = await import('./app-icon')
    const original = process.platform
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const win = { isDestroyed: () => false, setIcon: fixture.setIcon } as never
      mod.reapplyWindowIcon(win)
      expect(fixture.setIcon).toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', { value: original })
    }
    fixture.setIcon.mockClear()
    const dead = { isDestroyed: () => true, setIcon: fixture.setIcon } as never
    mod.reapplyWindowIcon(dead)
    expect(fixture.setIcon).not.toHaveBeenCalled()
  })
})
