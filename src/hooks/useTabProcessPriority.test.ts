import { afterEach, expect, it, vi } from 'vitest'
import { settleHooks } from './draft-hook-test-harness'
const harness = await vi.hoisted(async () => {
  const { createHookHarness } = await import('./draft-hook-test-harness')
  return createHookHarness()
})
const fixture = vi.hoisted(() => ({ sync: vi.fn().mockResolvedValue(true) }))
vi.mock('react', () => harness.react)
vi.mock('../lib/electron-api', () => ({ syncTabProcessPriority: fixture.sync }))
import { useTabProcessPriority } from './useTabProcessPriority'

afterEach(() => {
  harness.unmount()
  harness.reset()
  vi.clearAllMocks()
})
it('updates priority when the active or protected tabs change', async () => {
  const tabs = [{ id: 'a' }, { id: 'b' }, { id: 'media' }]
  const isProtected = (id: string) => id === 'media'
  harness.mount(() =>
    useTabProcessPriority({ windowId: 'main', tabs, activeTabId: 'a', isProtected }),
  )
  await settleHooks()
  expect(fixture.sync).toHaveBeenLastCalledWith({
    windowId: 'main',
    activeTabId: 'a',
    audibleTabIds: ['media'],
  })
  harness.mount(() => useTabProcessPriority({ windowId: 'main', tabs, activeTabId: 'b' }))
  await settleHooks()
  expect(fixture.sync).toHaveBeenLastCalledWith({
    windowId: 'main',
    activeTabId: 'b',
    audibleTabIds: [],
  })
})
it('waits for a window identity and tolerates a closed window', async () => {
  harness.mount(() => useTabProcessPriority({ windowId: '', tabs: [], activeTabId: null }))
  await settleHooks()
  expect(fixture.sync).not.toHaveBeenCalled()
  fixture.sync.mockRejectedValueOnce(new Error('Window closed'))
  harness.mount(() => useTabProcessPriority({ windowId: 'browser', tabs: [], activeTabId: null }))
  await settleHooks()
  expect(fixture.sync).toHaveBeenCalledTimes(1)
})
