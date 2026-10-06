import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../hotkey/uiohook.js', () => ({ UiohookKey: { F11: 87, C: 46, P: 25 } }))
import { dispatchBrowserHotkeyFallback, matchBrowserHotkeyFallback, setBrowserHotkeyFallback, tryForward, type BrowserHotkeyFallbackEvent } from './browser-hotkey-fallback'

const event = (keycode: number, modifiers: Partial<BrowserHotkeyFallbackEvent> = {}): BrowserHotkeyFallbackEvent => ({
  keycode, ctrl: false, alt: false, shift: false, meta: false, ...modifiers,
})

afterEach(() => {
  setBrowserHotkeyFallback(null)
  vi.useRealTimers()
})

describe('browser hook fallback', () => {
  it.each([
    [event(87), 'toggleFullscreen'],
    [event(46, { ctrl: true, alt: true }), 'toggleCloudPc'],
    [event(25, { alt: true }), 'toggleFreeze'],
    [event(122), null],
    [event(67, { ctrl: true, alt: true }), null],
    [event(80, { alt: true }), null],
    [event(87, { meta: true }), null],
    [event(25, { alt: true, shift: true }), null],
  ])('matches hook scan codes and exact modifiers for %j', (input, expected) => {
    expect(matchBrowserHotkeyFallback(input as BrowserHotkeyFallbackEvent)).toBe(expected)
  })

  it('keeps guest and hook deduplication scoped to the same host', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const firstHost = {}, secondHost = {}
    expect(tryForward('toggleFullscreen', firstHost)).toBe(true)
    expect(tryForward('toggleFullscreen', firstHost)).toBe(false)
    expect(tryForward('toggleFullscreen', secondHost)).toBe(true)
    expect(tryForward('toggleFreeze', firstHost)).toBe(true)
    vi.advanceTimersByTime(250)
    expect(tryForward('toggleFullscreen', firstHost)).toBe(true)
  })

  it('dispatches the hook event unchanged and releases the callback', () => {
    const callback = vi.fn()
    const input = event(25, { alt: true })
    setBrowserHotkeyFallback(callback)
    dispatchBrowserHotkeyFallback(input)
    expect(callback).toHaveBeenCalledWith(input)
    setBrowserHotkeyFallback(null)
    dispatchBrowserHotkeyFallback(input)
    expect(callback).toHaveBeenCalledOnce()
  })
})
