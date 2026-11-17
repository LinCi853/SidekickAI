import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = await vi.hoisted(async () =>
  (await import('../../../hooks/draft-hook-test-harness')).createHookHarness(),
)
const state = vi.hoisted(() => ({
  toast: vi.fn(),
  subscribe: vi.fn(),
  off: vi.fn(),
  onDownloadDone: vi.fn(),
}))
vi.mock('react', async () => ({ ...(await vi.importActual('react')), ...harness.react }))
vi.mock('../../../hooks/useToast', () => ({
  useToast: () => ({ toast: null, showToast: state.toast }),
}))
vi.mock('../../../lib/electron-api', () => ({
  dropFiles: vi.fn(),
  onDownloadDone: state.onDownloadDone,
  onAiFilesDropped: state.subscribe,
}))
vi.mock('../../../store/useTabStore', () => ({
  useTabStore: {
    getState: () => ({ tabs: [{ id: 'tab-1', profileId: 'profile-1' }], activeTabId: 'tab-1' }),
  },
}))
vi.mock('../../../store/useProfileStore', () => ({
  useProfileStore: {
    getState: () => ({
      profiles: [{ id: 'profile-1', aiPlatformId: 'chat', aiPlatformUrl: 'https://chat.test' }],
    }),
  },
}))
vi.mock('../file-drop-script', () => ({ buildFileDropScript: () => 'drop-script' }))
import { settleHooks } from '../../../hooks/draft-hook-test-harness'
import { useFileDragDrop } from './useFileDragDrop.js'

const webview = {
  getWebContentsId: () => 42,
  getAttribute: () => 'tab-1',
  executeJavaScript: vi.fn(),
}

beforeEach(() => {
  harness.reset()
  vi.resetAllMocks()
  state.subscribe.mockReturnValue(state.off)
  state.onDownloadDone.mockReturnValue(state.off)
  webview.executeJavaScript.mockResolvedValue({ success: true, method: 'input' })
  vi.stubGlobal('document', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    querySelector: vi.fn(() => webview),
    querySelectorAll: vi.fn(() => [webview]),
  })
})
afterEach(() => {
  harness.unmount()
  vi.unstubAllGlobals()
})

function mount() {
  return harness.mount(() => useFileDragDrop([]))
}

describe('AI page file drop fallback', () => {
  it('imports files handed back by the guest into the webview that received them', async () => {
    mount()
    const receive = state.subscribe.mock.calls[0][0] as (info: unknown) => void
    receive({
      guestId: 42,
      files: [
        {
          filename: 'report.png',
          dataUrl: 'data:image/png;base64,AA==',
          mime: 'image/png',
          size: 1,
        },
      ],
    })
    await settleHooks()
    expect(webview.executeJavaScript).toHaveBeenCalledWith('drop-script')
    expect(state.toast).toHaveBeenCalledWith('已导入 1 个文件到当前应用')
  })

  it('reports a missing target when the guest webview is already gone', async () => {
    mount()
    const receive = state.subscribe.mock.calls[0][0] as (info: unknown) => void
    receive({ guestId: 99, files: [] })
    expect(state.toast).toHaveBeenCalledWith('未找到接收文件的页面')
    expect(webview.executeJavaScript).not.toHaveBeenCalled()
  })

  it('releases the guest subscription on unmount', () => {
    mount()
    harness.unmount()
    expect(state.off).toHaveBeenCalled()
  })
})
