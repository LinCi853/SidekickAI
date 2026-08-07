/* =====================================================================
   hooks/useShortcutRegistry.ts —— 统一快捷键注册 hook（渲染层）
   C1 抽象层：在渲染层声明式注册快捷键，自动解析 accelerator（如 'Ctrl+T'
   → { ctrl: true, key: 't' }），在 keydown 事件中匹配修饰键与主键，命中后
   调用 handler。支持 enabled / capture / target 选项，unmount 时自动清理。

   本 hook 为 C1 抽象层，当前不强制重构 useBrowserKeyboard / useMainViewKeyboard，
   后续可在重构中应用。
   ===================================================================== */

import { useEffect, useRef, useCallback } from 'react'

export type ShortcutHandler = (event: KeyboardEvent) => void

export interface UseShortcutOptions {
  /** 是否启用（默认 true；为 false 时整体不注册监听） */
  enabled?: boolean
  /** 是否使用捕获阶段（默认 false，使用冒泡阶段） */
  capture?: boolean
  /** 目标元素（默认 window） */
  target?: HTMLElement | Window | null
}

export interface ShortcutEntry {
  /** 加速器字符串，如 'Ctrl+T'、'F11'、'Alt+Shift+D' */
  accelerator: string
  /** 命中回调 */
  handler: ShortcutHandler
  /** 单项启用开关（默认 true；为 false 时跳过该项） */
  enabled?: boolean
}

/** 修饰键名 → 是否为修饰键 */
const MODIFIER_NAMES = new Set(['CTRL', 'CONTROL', 'ALT', 'OPTION', 'SHIFT', 'CMD', 'COMMAND', 'META', 'SUPER'])

/** 将 accelerator 中的键名规范化为与 KeyboardEvent.key 可比较的小写形式 */
function normalizeKeyName(part: string): string {
  const up = part.toUpperCase()
  // 功能键 F1-F24：保持小写形式以与 event.key.toLowerCase() 对齐
  if (/^F\d{1,2}$/.test(up)) return up.toLowerCase()
  // 特殊键映射（值统一为小写，与 event.key 一致）
  const specialMap: Record<string, string> = {
    SPACE: ' ',
    SPACEBAR: ' ',
    ENTER: 'enter',
    RETURN: 'enter',
    TAB: 'tab',
    ESC: 'escape',
    ESCAPE: 'escape',
    BACKSPACE: 'backspace',
    DELETE: 'delete',
    DEL: 'delete',
    INSERT: 'insert',
    HOME: 'home',
    END: 'end',
    PAGEUP: 'pageup',
    PAGEDOWN: 'pagedown',
    UP: 'arrowup',
    DOWN: 'arrowdown',
    LEFT: 'arrowleft',
    RIGHT: 'arrowright',
    PLUS: '+',
    EQUAL: '=',
    MINUS: '-',
    COMMA: ',',
    PERIOD: '.',
    SLASH: '/',
    SEMICOLON: ';',
    QUOTE: "'",
    BACKTICK: '`',
    BRACKETLEFT: '[',
    BRACKETRIGHT: ']',
    BACKSLASH: '\\',
  }
  if (up in specialMap) return specialMap[up]
  // 字母 / 数字直接小写
  return part.toLowerCase()
}

/** 解析 accelerator 字符串为修饰键 + 主键 */
export function parseAccelerator(accelerator: string): {
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  key: string
} {
  const parts = accelerator
    .split('+')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  let ctrl = false
  let alt = false
  let shift = false
  let meta = false
  let key = ''

  for (const part of parts) {
    const up = part.toUpperCase()
    if (up === 'CTRL' || up === 'CONTROL') {
      ctrl = true
    } else if (up === 'ALT' || up === 'OPTION') {
      alt = true
    } else if (up === 'SHIFT') {
      shift = true
    } else if (up === 'CMD' || up === 'COMMAND' || up === 'META' || up === 'SUPER') {
      meta = true
    } else if (!key) {
      // 第一个非修饰键作为主键
      key = normalizeKeyName(part)
    }
  }

  return { ctrl, alt, shift, meta, key }
}

/** 匹配键盘事件与 accelerator */
export function matchAccelerator(event: KeyboardEvent, accelerator: string): boolean {
  const parsed = parseAccelerator(accelerator)
  // 无主键的 accelerator 无法匹配
  if (!parsed.key) return false
  // 修饰键严格匹配
  if (event.ctrlKey !== parsed.ctrl) return false
  if (event.altKey !== parsed.alt) return false
  if (event.shiftKey !== parsed.shift) return false
  if (event.metaKey !== parsed.meta) return false
  // 主键匹配（大小写不敏感）
  return event.key.toLowerCase() === parsed.key
}

/**
 * 统一快捷键注册 hook
 * 在渲染层声明式注册快捷键，自动处理修饰键匹配，unmount 时清理监听。
 *
 * @param shortcuts 快捷键注册列表（accelerator + handler + 可选 enabled）
 * @param options   全局选项（enabled / capture / target）
 */
export function useShortcutRegistry(
  shortcuts: ShortcutEntry[],
  options: UseShortcutOptions = {},
): void {
  const { enabled = true, capture = false, target } = options

  // 用 ref 持有最新的 shortcuts 列表，避免每次渲染都重新绑定监听
  const shortcutsRef = useRef(shortcuts)
  shortcutsRef.current = shortcuts

  // 稳定的 keydown 处理函数（依赖数组为空，引用永久稳定）
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    const list = shortcutsRef.current
    for (const entry of list) {
      // 单项 enabled 优先，未定义视为启用
      if (entry.enabled === false) continue
      if (matchAccelerator(event, entry.accelerator)) {
        entry.handler(event)
        // 命中后不再继续匹配其他项（避免一次按键触发多个 handler）
        return
      }
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    const node: EventTarget = target ?? window
    node.addEventListener('keydown', handleKeyDown as EventListener, capture)
    return () => {
      node.removeEventListener('keydown', handleKeyDown as EventListener, capture)
    }
  }, [enabled, capture, target, handleKeyDown])
}
