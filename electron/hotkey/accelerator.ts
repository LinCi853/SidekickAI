// electron/hotkey/accelerator.ts — accelerator 字符串解析（纯函数）

import { UiohookKey } from './uiohook.js'

/** accelerator 字符串 -> uiohook 按键代码（字母/数字/功能键） */
function acceleratorToUiohookKey(part: string): number | null {
  const upper = part.toUpperCase()

  // 字母 A-Z
  if (/^[A-Z]$/.test(upper)) {
    return UiohookKey[upper as keyof typeof UiohookKey] as number
  }

  // 数字 0-9
  if (/^\d$/.test(upper)) {
    return UiohookKey[upper as '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9']
  }

  // 功能键 F1-F24
  const fMatch = /^F(\d{1,2})$/.exec(upper)
  if (fMatch) {
    const key = `F${fMatch[1]}` as keyof typeof UiohookKey
    if (key in UiohookKey) return UiohookKey[key] as number
  }

  // 特殊键
  const map: Record<string, number> = {
    SPACE: UiohookKey.Space,
    SPACEBAR: UiohookKey.Space,
    ENTER: UiohookKey.Enter,
    RETURN: UiohookKey.Enter,
    TAB: UiohookKey.Tab,
    ESC: UiohookKey.Escape,
    ESCAPE: UiohookKey.Escape,
    BACKSPACE: UiohookKey.Backspace,
    DELETE: UiohookKey.Delete,
    INSERT: UiohookKey.Insert,
    HOME: UiohookKey.Home,
    END: UiohookKey.End,
    PAGEUP: UiohookKey.PageUp,
    PAGEDOWN: UiohookKey.PageDown,
    UP: UiohookKey.ArrowUp,
    DOWN: UiohookKey.ArrowDown,
    LEFT: UiohookKey.ArrowLeft,
    RIGHT: UiohookKey.ArrowRight,
    PLUS: UiohookKey.Equal, // Electron 用 Plus 表示 "=" 加 Shift，uiohook 无 Plus，映射为 Equal
    EQUAL: UiohookKey.Equal,
    MINUS: UiohookKey.Minus,
    COMMA: UiohookKey.Comma,
    PERIOD: UiohookKey.Period,
    SLASH: UiohookKey.Slash,
    SEMICOLON: UiohookKey.Semicolon,
    QUOTE: UiohookKey.Quote,
    BACKTICK: UiohookKey.Backquote,
    BRACKETLEFT: UiohookKey.BracketLeft,
    BRACKETRIGHT: UiohookKey.BracketRight,
    BACKSLASH: UiohookKey.Backslash,
  }
  return map[upper] ?? null
}

/** 解析 accelerator 字符串为匹配条件 */
export function parseAccelerator(acc: string): {
  keycode: number | null
  alt: boolean
  ctrl: boolean
  shift: boolean
  meta: boolean
} {
  const parts = acc.split('+').map((p) => p.trim())
  let alt = false
  let ctrl = false
  let shift = false
  let meta = false
  let keyPart = ''

  for (const part of parts) {
    const up = part.toUpperCase()
    if (up === 'ALT' || up === 'OPTION') alt = true
    else if (up === 'CTRL' || up === 'CONTROL') ctrl = true
    else if (up === 'SHIFT') shift = true
    else if (up === 'CMD' || up === 'COMMAND' || up === 'META' || up === 'SUPER') meta = true
    else keyPart = part
  }

  return {
    keycode: keyPart ? acceleratorToUiohookKey(keyPart) : null,
    alt,
    ctrl,
    shift,
    meta,
  }
}
