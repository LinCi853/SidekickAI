import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHookHarness, deferred, elements, settle } from '../test/hook-harness'
import type { UpdateState } from '../../electron/updates/types'

const mocks = vi.hoisted(() => ({ hooks: null as any, check: vi.fn(), accept: vi.fn(), getState: vi.fn(), cancel: vi.fn(), open: vi.fn() }))
vi.mock('react', () => ({ useState: (...args: any[]) => mocks.hooks.useState(...args), useEffect: (...args: any[]) => mocks.hooks.useEffect(...args) }))
vi.mock('lucide-react', () => ({ RefreshCw: 'RefreshCw', Download: 'Download', X: 'X', ExternalLink: 'ExternalLink' }))
import UpdateStatus from './UpdateStatus'

const offer = { id: 'accepted-release', version: '0.1.7', notes: 'Release notes', sizeBytes: 1024, kind: 'installed' as const }
const available: UpdateState = { phase: 'available', offer, downloadedBytes: 0, error: null }
let harness: ReturnType<typeof createHookHarness>
beforeEach(() => {
  vi.clearAllMocks()
  harness = createHookHarness(); mocks.hooks = harness.hooks
  mocks.getState.mockResolvedValue({ phase: 'idle', offer: null, downloadedBytes: 0, error: null })
  mocks.check.mockResolvedValue(available)
  mocks.accept.mockResolvedValue({ ...available, phase: 'ready' })
  vi.stubGlobal('window', { electron: { updates: { getState: mocks.getState, check: mocks.check, accept: mocks.accept, cancel: mocks.cancel, openReleases: mocks.open } } })
})
afterEach(() => { harness.unmount(); vi.unstubAllGlobals() })
const render = () => harness.render(() => UpdateStatus())
const button = (label: string) => elements(render()).find(element => element.type === 'button' && (element.props['aria-label'] === label || [element.props.children].flat().includes(label)))!

it('checks only on request and opens maintenance only after accepting the exact offer', async () => {
  render(); await settle(); render()
  expect(mocks.check).not.toHaveBeenCalled()
  await button('检查更新').props.onClick(); await settle(); render()
  expect(mocks.accept).not.toHaveBeenCalled()
  await button('下载并打开安装向导').props.onClick(); await settle()
  expect(mocks.accept).toHaveBeenCalledWith('accepted-release')
  expect(JSON.stringify(render())).toContain('等待维护操作')
})
it('uses a ZIP action for portable offers and never calls installation implicitly', async () => {
  mocks.check.mockResolvedValue({ ...available, offer: { ...offer, kind: 'portable' } })
  render(); await settle(); await button('检查更新').props.onClick(); await settle()
  expect(button('保存新版绿色 ZIP')).toBeTruthy()
  expect(mocks.accept).not.toHaveBeenCalled()
})
it('blocks repeated checks while a request is pending and presents one failure', async () => {
  const pending = deferred<UpdateState>()
  mocks.check.mockReturnValue(pending.promise)
  render(); await settle()
  button('检查更新').props.onClick(); await settle()
  expect(button('检查更新').props.disabled).toBe(true)
  pending.reject(new Error('Service unavailable')); await settle()
  const alerts = elements(render()).filter(element => element.props.role === 'alert')
  expect(alerts).toHaveLength(1)
  expect(alerts[0].props.children).toBe('Service unavailable')
})
