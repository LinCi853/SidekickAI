import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'

const electron = vi.hoisted(() => ({ sendSync: vi.fn() }))
vi.mock('electron', () => ({ ipcRenderer: { sendSync: electron.sendSync } }))
import { installFocusReporter } from './focus-reporter.js'

let listeners: Map<string, Array<(event: unknown) => void>>
function dispatch(type: string): void {
  for (const callback of listeners.get(type) ?? []) callback({})
}
class FakeHTMLElement { constructor(public tagName: string, public isContentEditable = false) {} }
const element = (tagName: string, isContentEditable = false) => new FakeHTMLElement(tagName, isContentEditable)

beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks()
  listeners = new Map()
  vi.stubGlobal('window', { addEventListener: (type: string, callback: (event: unknown) => void) => { listeners.set(type, [...listeners.get(type) ?? [], callback]) } })
  vi.stubGlobal('HTMLElement', FakeHTMLElement)
  vi.stubGlobal('document', { body: element('BODY'), activeElement: null as FakeHTMLElement | null })
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('guest editable focus reporting', () => {
  it('reports the initial focus state once installed', () => {
    installFocusReporter()
    expect(electron.sendSync).toHaveBeenCalledTimes(1)
    expect(electron.sendSync).toHaveBeenCalledWith(IPC_CHANNELS.WEBVIEW_FOCUS_EDITABLE, false)
  })

  it.each([
    ['input', element('INPUT'), true],
    ['contenteditable', element('DIV', true), true],
    ['iframe', element('IFRAME'), true],
    ['page body', element('BODY'), false],
    ['plain element', element('SPAN'), false],
  ])('reports %s focus as %s on focusin', (_name, active, expected) => {
    installFocusReporter(); electron.sendSync.mockClear()
    ;(document as any).activeElement = active
    dispatch('focusin')
    expect(electron.sendSync).toHaveBeenCalledTimes(1)
    expect(electron.sendSync).toHaveBeenCalledWith(IPC_CHANNELS.WEBVIEW_FOCUS_EDITABLE, expected)
  })

  it('re-reports the settled target after focusout', () => {
    installFocusReporter(); electron.sendSync.mockClear()
    ;(document as any).activeElement = element('INPUT')
    dispatch('focusin')
    ;(document as any).activeElement = element('BODY')
    dispatch('focusout')
    expect(electron.sendSync).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(electron.sendSync).toHaveBeenLastCalledWith(IPC_CHANNELS.WEBVIEW_FOCUS_EDITABLE, false)
  })
})
