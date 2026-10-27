import { describe, expect, it } from 'vitest'
import { HotkeyInputState, modifierKeyCodes, type KeyObservation } from './input-state.js'

const keys = {
  Alt: 56,
  AltRight: 3640,
  Ctrl: 29,
  CtrlRight: 3613,
  Shift: 42,
  ShiftRight: 54,
  Meta: 3675,
  MetaRight: 3676,
  Space: 57,
  Tab: 15,
  Escape: 1,
  F4: 62,
}
const binding = { keycode: keys.Space, alt: true, ctrl: false, shift: false, meta: false }
const event = (keycode: number, flags: Partial<KeyObservation> = {}): KeyObservation => ({
  keycode,
  altKey: false,
  ctrlKey: false,
  shiftKey: false,
  metaKey: false,
  ...flags,
})

describe('physical shortcut input', () => {
  it('recognizes the installed hook right-side names', () => {
    const codes = modifierKeyCodes(keys)
    expect(codes.alt.has(keys.AltRight)).toBe(true)
    expect(codes.ctrl.has(keys.CtrlRight)).toBe(true)
    expect(codes.shift.has(keys.ShiftRight)).toBe(true)
    expect(codes.meta.has(keys.MetaRight)).toBe(true)
  })
  it.each([keys.Alt, keys.AltRight])('accepts observed modifier %s once per press', (alt) => {
    const input = new HotkeyInputState(keys)
    input.observe(event(alt, { altKey: true }), true)
    input.observe(event(keys.Space, { altKey: true }), true)
    expect(input.claim(binding)).toBe(true)
    input.observe(event(keys.Space, { altKey: true }), true)
    expect(input.claim(binding)).toBe(false)
    input.observe(event(keys.Space, { altKey: true }), false)
    input.observe(event(keys.Space, { altKey: true }), true)
    expect(input.claim(binding)).toBe(true)
  })
  it.each([false, true])(
    'rejects a lost modifier release after switching windows, mask=%s',
    (altKey) => {
      const input = new HotkeyInputState(keys)
      input.observe(event(keys.Alt, { altKey: true }), true)
      input.observe(event(keys.Tab, { altKey: true }), true)
      input.observe(event(keys.Tab, { altKey: true }), false)
      input.observe(event(keys.Space, { altKey }), true)
      expect(input.claim(binding)).toBe(false)
    },
  )
  it('invalidates Alt authorization after closing a window with Alt+F4', () => {
    const input = new HotkeyInputState(keys)
    input.observe(event(keys.Alt, { altKey: true }), true)
    input.observe(event(keys.F4, { altKey: true }), true)
    input.observe(event(keys.F4, { altKey: true }), false)
    input.observe(event(keys.Space, { altKey: true }), true)
    expect(input.claim(binding)).toBe(false)
    input.observe(event(keys.Space), false)
    input.observe(event(keys.Alt), false)
    input.observe(event(keys.Alt, { altKey: true }), true)
    input.observe(event(keys.Space, { altKey: true }), true)
    expect(input.claim(binding)).toBe(true)
  })
  it('keeps the chord live across unreliable false masks (consecutive presses)', () => {
    const input = new HotkeyInputState(keys)
    // uiohook 的 mask 在注入输入/焦点切换后可能恒 false，不得因此撤销授权
    input.observe(event(keys.Alt), true, 1000)
    input.observe(event(keys.Space), true, 1100)
    expect(input.claim(binding)).toBe(true)
    input.observe(event(keys.Space), false, 1130)
    input.observe(event(keys.Space), true, 1400)
    expect(input.claim(binding)).toBe(true)
    input.observe(event(keys.Space), false, 1430)
    input.observe(event(keys.Space), true, 1700)
    expect(input.claim(binding)).toBe(true)
  })
  it('heals a lost modifier release after the silence window', () => {
    const input = new HotkeyInputState(keys)
    input.observe(event(keys.Alt), true, 1000)
    input.observe(event(keys.Space), true, 1100)
    expect(input.claim(binding)).toBe(true)
    input.observe(event(keys.Space), false, 1130)
    // Alt 的 keyup 丢失：超过静默上限后下一按键应撤销残留授权，避免单键误触发
    input.observe(event(keys.Space), true, 2600)
    expect(input.claim(binding)).toBe(false)
  })
  it('rejects stale positive masks and additional unobserved modifiers', () => {
    const input = new HotkeyInputState(keys)
    input.observe(event(keys.Space, { altKey: true }), true)
    expect(input.claim(binding)).toBe(false)
    input.observe(event(keys.Space), false)
    input.observe(event(keys.Alt, { altKey: true }), true)
    input.observe(event(keys.Space, { altKey: true, shiftKey: true }), true)
    expect(input.claim(binding)).toBe(false)
  })
  it('keeps the other modifier side authorized after one side is released', () => {
    const input = new HotkeyInputState(keys)
    input.observe(event(keys.Alt, { altKey: true }), true)
    input.observe(event(keys.AltRight, { altKey: true }), true)
    input.observe(event(keys.Alt, { altKey: true }), false)
    input.observe(event(keys.Space, { altKey: true }), true)
    expect(input.claim(binding)).toBe(true)
  })
  it('requires release and a fresh modifier press after suspension', () => {
    const input = new HotkeyInputState(keys)
    input.observe(event(keys.Alt, { altKey: true }), true)
    input.suspend()
    input.observe(event(keys.Alt, { altKey: true }), true)
    input.observe(event(keys.Space, { altKey: true }), true)
    expect(input.claim(binding)).toBe(false)
    input.observe(event(keys.Space, { altKey: true }), false)
    input.observe(event(keys.Alt), false)
    input.observe(event(keys.Alt, { altKey: true }), true)
    input.observe(event(keys.Space, { altKey: true }), true)
    expect(input.claim(binding)).toBe(true)
  })
})
