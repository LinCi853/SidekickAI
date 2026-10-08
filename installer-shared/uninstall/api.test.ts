import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { createUninstallApi } from './api'
import type { UninstallRequest } from './protocol'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))

const request: UninstallRequest = {
  protocolVersion: 2, requestId: 'request', scanId: 'scan', targetId: { token: 'target' },
  strategy: 'keep', additionalTargetIds: [], confirmation: 'delete-v2',
}

beforeEach(() => vi.resetAllMocks())

describe('uninstall bridge lifecycle', () => {
  it('treats a switching admission as a quiet response without an operation', async () => {
    vi.mocked(listen).mockResolvedValue(() => {})
    vi.mocked(invoke).mockResolvedValue(null)
    const api = createUninstallApi()
    const off = api.onEvent(() => {})
    expect(await api.start(request)).toBeNull()
    off()
  })
  it('does not submit before the event listener is established', async () => {
    let establish!: (off: () => void) => void
    vi.mocked(listen).mockImplementation(() => new Promise((resolve) => { establish = resolve }))
    vi.mocked(invoke).mockResolvedValue({ requestId: 'request', operationId: 'operation', state: 'accepted' })
    const api = createUninstallApi()
    const off = api.onEvent(() => {})
    const pending = api.start(request)
    await Promise.resolve()
    expect(invoke).not.toHaveBeenCalled()
    const dispose = vi.fn()
    establish(dispose)
    await pending
    expect(invoke).toHaveBeenCalledWith('uninstall_start', { request })
    off()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('refuses a start when no event subscriber exists', async () => {
    await expect(createUninstallApi().start(request)).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('keeps a failed listener from issuing delete requests and allows a fresh subscription', async () => {
    vi.mocked(listen).mockRejectedValueOnce(new Error('listener unavailable'))
    const api = createUninstallApi()
    const diagnostics = vi.fn()
    const offError = api.onEventError!(diagnostics)
    const off = api.onEvent(() => {})
    await expect(api.start(request)).rejects.toThrow('listener unavailable')
    expect(invoke).not.toHaveBeenCalled()
    expect(diagnostics).toHaveBeenCalled()
    off()
    const dispose = vi.fn()
    vi.mocked(listen).mockResolvedValueOnce(dispose)
    const newOff = api.onEvent(() => {})
    await api.whenReady!()
    expect(listen).toHaveBeenCalledTimes(2)
    newOff(); offError()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('releases an asynchronously established listener after unmount', async () => {
    let establish!: (off: () => void) => void
    vi.mocked(listen).mockImplementation(() => new Promise((resolve) => { establish = resolve }))
    const api = createUninstallApi()
    const off = api.onEvent(() => {})
    await Promise.resolve()
    off()
    const dispose = vi.fn()
    establish(dispose)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(invoke).not.toHaveBeenCalled()
  })
})
