import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
vi.mock('../../../store/useModuleStore', () => ({ useModuleStore: (selector: any) => selector({ modules: [{ id: 'prompt-library', enabled: true }] }) }))
vi.mock('../../../lib/electron-api', () => ({ startHotkeyRecording: vi.fn(), stopHotkeyRecording: vi.fn(), onHotkeyRecordingResult: vi.fn(), onHotkeyRecordingPartial: vi.fn() }))
vi.mock('../../ui', () => ({ SectionTitle: 'h2' }))
vi.mock('../../ui/HotkeyRecorder', () => ({ default: (props: any) => <input data-action={props.value || 'unbound'} value={props.value} placeholder={props.placeholder} readOnly /> }))
import HotkeySection from './HotkeySection'
const configs = [
  { action: 'toggleMainWindow' as const, label: '切换主窗口显隐', accelerator: 'Alt+Space', enabled: true },
  { action: 'toggleAiAssets' as const, label: '打开／关闭 AI资产', accelerator: '', enabled: false },
]
describe('AI asset shortcut settings presentation', () => {
  it('shows an unbound asset shortcut without borrowing the main window accelerator', () => {
    const html = renderToStaticMarkup(<HotkeySection hotkeys={configs} drafts={{ toggleMainWindow: 'Alt+Space', toggleAiAssets: '' }} savingAction={null} feedback={{}} setDrafts={vi.fn()} handleSaveHotkey={vi.fn()} />)
    expect(html).toContain('value="Alt+Space"')
    expect(html).toContain('data-action="unbound" placeholder="未绑定"')
  })
  it('does not offer to enable a shortcut whose saved combination is empty', () => {
    const html = renderToStaticMarkup(<HotkeySection hotkeys={[configs[1]]} drafts={{ toggleAiAssets: '' }} savingAction={null} feedback={{}} setDrafts={vi.fn()} handleSaveHotkey={vi.fn()} />)
    expect(html).toContain('type="checkbox" disabled=""')
  })
})
