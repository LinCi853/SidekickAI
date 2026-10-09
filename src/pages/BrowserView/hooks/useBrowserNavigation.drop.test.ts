import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalFilesDroppedEvent } from '../../../../electron/shared/api/settings.api.js'

const harness = await vi.hoisted(async () => (await import('../../../hooks/draft-hook-test-harness')).createHookHarness())
const state = vi.hoisted(() => ({ off: vi.fn(), subscribe: vi.fn(), open: vi.fn(), newTab: vi.fn() }))
vi.mock('react', async () => ({ ...await vi.importActual('react'), ...harness.react }))
vi.mock('../../../store/useBrowserTabStore.js', () => ({ useBrowserTabStore: { getState: () => ({ tabs: [], activeTabId: null }) } }))
import { useBrowserNavigation } from './useBrowserNavigation.js'

beforeEach(() => {
  harness.reset(); vi.resetAllMocks(); state.open.mockResolvedValue(undefined); state.subscribe.mockReturnValue(state.off)
  vi.stubGlobal('window', Object.assign(new EventTarget(), { electron: { appSettings: { onLocalFilesDropped: state.subscribe, openDroppedFiles: state.open } } }))
})
afterEach(() => { harness.unmount(); vi.unstubAllGlobals() })
function mount() {
  return harness.mount(() => useBrowserNavigation({ activeTabId: null, activeProfile: null, tabs: [], newTab: state.newTab, switchTab: vi.fn() }))
}

describe('browser native file viewing', () => {
  it('opens main-process snapshots and releases its named subscription', () => {
    mount(); const receive = state.subscribe.mock.calls[0][0] as (event: LocalFilesDroppedEvent) => void
    receive({ guestId: 4, files: [
      { name: 'report.pdf', url: 'sidekickai://print-preview?file=private-capability', kind: 'pdf' },
      { name: 'photo.png', url: 'file:///E:/controlled/snapshot/photo.png', kind: 'file' },
    ] })
    expect(state.newTab.mock.calls).toEqual([
      ['sidekickai://print-preview?file=private-capability', { source: 'print-preview', kind: 'web' }],
      ['file:///E:/controlled/snapshot/photo.png', { kind: 'web' }],
    ])
    harness.unmount(); expect(state.off).toHaveBeenCalledOnce()
  })

  it('ignores the former page event channel and passes no path when consuming a native drop', () => {
    const mounted = mount()
    window.dispatchEvent(Object.assign(new Event('browser-local-files-drop'), { detail: { paths: ['E:/unselected/file.pdf'] } }))
    expect(state.newTab).not.toHaveBeenCalled()
    const event = { nativeEvent: { isTrusted: false }, dataTransfer: { files: [{ path: 'E:/unselected/file.pdf' }] }, preventDefault: vi.fn() }
    mounted.current.handleDrop(event as any); expect(state.open).not.toHaveBeenCalled()
    event.nativeEvent.isTrusted = true; mounted.current.handleDrop(event as any)
    expect(state.open.mock.calls).toEqual([[]]); expect(event.preventDefault).toHaveBeenCalledOnce()
  })
})
