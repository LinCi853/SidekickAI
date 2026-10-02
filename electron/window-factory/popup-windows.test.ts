import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ enabled: true, create: vi.fn(), send: vi.fn() }))
vi.mock('../window-state.js', () => ({ windowState: { promptWindow: null } }))
vi.mock('../modules/registry.js', () => ({ isModuleEnabled: () => state.enabled }))
vi.mock('./helpers.js', () => ({ PROMPT_WINDOW_ID: 'prompts', createSingletonPopupWindow: (options: unknown) => { state.create(options); return { webContents: { send: state.send } } } }))
import { showHistoryWindow, showPromptWindow } from './popup-windows'
import { getAssetNavigation } from '../assets/navigation'

beforeEach(() => { state.enabled = true; state.create.mockClear(); state.send.mockClear() })
describe('asset window entrances', () => {
  it('refuses both the legacy search route and the direct asset route while disabled', () => {
    state.enabled = false
    showHistoryWindow(); showPromptWindow({ category: 'prompts' })
    expect(state.create).not.toHaveBeenCalled()
    expect(state.send).not.toHaveBeenCalled()
  })
  it('keeps search and template requests on one module-owned window', () => {
    showHistoryWindow()
    expect(getAssetNavigation().focusSearch).toBe(true)
    showPromptWindow({ category: 'prompts' })
    expect(getAssetNavigation().category).toBe('prompts')
    expect(state.create.mock.calls.every(([options]) => options.windowId === 'prompts')).toBe(true)
  })
})
