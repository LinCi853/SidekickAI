import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcRenderer: { invoke: vi.fn(async () => false), on: vi.fn(), removeListener: vi.fn() },
}))

afterEach(() => vi.unstubAllGlobals())

describe('preload document readiness', () => {
  it('initializes DOM attributes after the document element becomes available', async () => {
    const listeners = new Map<string, () => void>()
    const root = { setAttribute: vi.fn() }
    const document = {
      readyState: 'loading',
      documentElement: null as typeof root | null,
      addEventListener: vi.fn((event: string, callback: () => void) => listeners.set(event, callback)),
    }
    vi.stubGlobal('document', document)
    vi.stubGlobal('window', {})
    const { setupDomSideEffects } = await import('./bootstrap.js')
    expect(() => setupDomSideEffects()).not.toThrow()
    document.documentElement = root
    listeners.get('DOMContentLoaded')?.()
    await Promise.resolve()
    expect(root.setAttribute).toHaveBeenCalledWith('data-platform', process.platform)
    expect(listeners.has('click')).toBe(true)
  })
})
