import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HotkeyConfig } from '../../electron/shared/types'
import { DEFAULT_ASSET_SETTINGS } from '../../electron/shared/asset-settings'
import { settleHooks } from '../hooks/draft-hook-test-harness'
const harness = await vi.hoisted(async () => (await import('../hooks/draft-hook-test-harness')).createHookHarness())
const state = vi.hoisted(() => ({ listener: undefined as undefined | ((values: HotkeyConfig[]) => void), off: vi.fn(), bridge: undefined as any }))
const api = vi.hoisted(() => ({ getAll: vi.fn(), set: vi.fn(), setEnabled: vi.fn(), onChanged: vi.fn() }))
vi.mock('react', async () => ({ ...await vi.importActual('react'), ...harness.react }))
vi.mock('../lib/electron-api/core', () => ({ requireElectron: () => state.bridge }))
vi.mock('../hooks/useAssetSettings', () => ({ useAssetSettings: () => ({ settings: DEFAULT_ASSET_SETTINGS, update: vi.fn(), error: '' }) }))
vi.mock('../store/useModuleStore', () => ({ useModuleStore: (selector: any) => selector({ isEnabled: () => false }) }))
vi.mock('./ui', () => ({ Button: 'button' }))
vi.mock('../pages/ai-assets/AssetFreezeControl', () => ({ default: () => null }))
import AssetSettingsPanel from './AssetSettingsPanel'
const configured = (accelerator = '', enabled = false, registration?: HotkeyConfig['registration']): HotkeyConfig => ({ action: 'toggleAiAssets', label: '打开／关闭 AI资产', accelerator, enabled, registration })
function elements(node: any): any[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!node || typeof node !== 'object' || !node.props) return []
  return [node, ...elements(node.props.children)]
}
const find = (node: unknown, predicate: (element: any) => boolean) => elements(node).find(predicate)!
const input = (node: unknown) => find(node, element => element.props['aria-label'] === '打开／关闭 AI资产快捷键')
const save = (node: unknown) => find(node, element => element.type === 'button' && element.props.children === '保存全局快捷键')
const enabled = (node: unknown) => find(node, element => element.type === 'label' && Array.isArray(element.props.children) && element.props.children.includes('启用全局快捷键')).props.children[0]
beforeEach(() => {
  harness.reset(); vi.resetAllMocks(); state.listener = undefined
  state.bridge = { hotkey: api, aiAssets: { cleanupRecords: vi.fn() } }
  api.getAll.mockResolvedValue([configured()])
  api.onChanged.mockImplementation(listener => { state.listener = listener; return state.off })
  api.set.mockImplementation(async (_action, accelerator) => { state.listener?.([configured(accelerator, !!accelerator, accelerator ? 'registered' : undefined)]); return true })
})
afterEach(async () => { harness.unmount(); await settleHooks() })
describe('AI asset embedded shortcut settings', () => {
  it('shows the same unbound state and unavailable enable switch as global settings', async () => {
    const view = harness.mount(() => AssetSettingsPanel({})); await settleHooks()
    expect(input(view.current).props).toMatchObject({ value: '', placeholder: '未绑定' })
    expect(enabled(view.current).props).toMatchObject({ checked: false, disabled: true })
  })
  it('reflects a persisted shortcut and its updates from the other settings entrance', async () => {
    api.getAll.mockResolvedValue([configured('Ctrl+Alt+A', true, 'registered')])
    const view = harness.mount(() => AssetSettingsPanel({})); await settleHooks()
    expect(input(view.current).props.value).toBe('Ctrl+Alt+A')
    expect(enabled(view.current).props.checked).toBe(true)
    state.listener!([configured('Ctrl+Shift+A', false)])
    await settleHooks()
    expect(input(view.current).props.value).toBe('Ctrl+Shift+A')
    expect(enabled(view.current).props.checked).toBe(false)
  })
  it('clears the AI asset binding through the shared runtime action and shows it disabled', async () => {
    api.getAll.mockResolvedValue([configured('Ctrl+Alt+A', true, 'registered')])
    const view = harness.mount(() => AssetSettingsPanel({})); await settleHooks()
    input(view.current).props.onChange({ target: { value: '' } })
    await settleHooks()
    save(view.current).props.onClick(); await settleHooks()
    expect(api.set).toHaveBeenCalledWith('toggleAiAssets', '')
    expect(enabled(view.current).props).toMatchObject({ checked: false, disabled: true })
  })
  it('keeps duplicate-combination refusal visible without claiming registration success', async () => {
    api.set.mockRejectedValue(new Error('快捷键与其他操作重复'))
    const view = harness.mount(() => AssetSettingsPanel({})); await settleHooks()
    input(view.current).props.onChange({ target: { value: 'Alt+Space' } })
    await settleHooks()
    save(view.current).props.onClick(); await settleHooks()
    expect(api.set).toHaveBeenCalledWith('toggleAiAssets', 'Alt+Space')
    expect(find(view.current, element => element.props.role === 'alert').props.children).toContain('快捷键与其他操作重复')
    expect(enabled(view.current).props.checked).toBe(false)
  })
  it('shows the dedicated legacy-collision reason returned by the runtime', async () => {
    api.getAll.mockResolvedValue([{ ...configured('Alt+Space', true, 'conflict'), registrationReason: '与「切换主窗口显隐」快捷键重复，请为 AI资产设置独立组合。' }])
    const view = harness.mount(() => AssetSettingsPanel({})); await settleHooks()
    expect(find(view.current, element => element.props.role === 'status').props.children).toContain('主窗口显隐')
    harness.unmount(); expect(state.off).toHaveBeenCalledTimes(1)
  })
})
