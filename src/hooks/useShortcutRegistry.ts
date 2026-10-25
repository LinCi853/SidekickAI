/* =====================================================================
   hooks/useShortcutRegistry.ts —— 统一快捷键注册 hook（渲染层）
   C1 抽象层：在渲染层声明式注册快捷键，自动解析 accelerator（如 'Ctrl+T'
   → { ctrl: true, key: 't' }），在 keydown 事件中匹配修饰键与主键，命中后
   调用 handler。支持 enabled / capture / target 选项，unmount 时自动清理。

   本 hook 为 C1 抽象层，当前不强制重构 useBrowserKeyboard / useMainViewKeyboard，
   后续可在重构中应用。
   ===================================================================== */

import { useEffect, useRef, useCallback } from 'react'
import { isTypingTarget } from '../lib/shared-utils'

export type ShortcutHandler = (event: KeyboardEvent) => void

export interface UseShortcutOptions {
  /** 是否启用（默认 true；为 false 时整体不注册监听） */
  enabled?: boolean
  /** 是否使用捕获阶段（默认 false，使用冒泡阶段） */
  capture?: boolean
  /** 目标元素（默认 window） */
  target?: HTMLElement | Window | null
  /** 忽略键盘长按自动重复事件（默认 false；浏览器等快捷键场景应设为 true） */
  ignoreRepeat?: boolean
}

export interface ShortcutEntry {
  /** 加速器字符串，如 'Ctrl+T'、'F11'、'Alt+Shift+D' */
  accelerator: string
  /** 立即命中回调（keydown 匹配即触发） */
  handler?: ShortcutHandler
  /** 单项启用开关（默认 true；为 false 时跳过该项） */
  enabled?: boolean
  /**
   * 长按模式：按住达到 holdMs 毫秒后触发 handler（一次）；
   * 提前松开则取消。用于「长按 Tab 调底栏」等设计。
   */
  holdMs?: number
  /** 按住开始回调（keydown 命中即触发，可 preventDefault；用于按住录音等） */
  onHoldStart?: (event: KeyboardEvent) => void
  /** 按住结束回调（对应 keyup 触发；用于松开结束录音、关闭速览等） */
  onHoldEnd?: (event: KeyboardEvent) => void
  /** 允许键盘 auto-repeat 触发（切标签等需连按/长按）；全局 ignoreRepeat 时仍放行本条 */
  allowRepeat?: boolean
  /** 物理键 code 匹配（如 Backquote），与 event.key 解耦；设置后仍要求修饰键匹配 */
  code?: string
  /** 焦点在可编辑元素时跳过（不影响输入） */
  ignoreWhenTyping?: boolean
}

/** 修饰键名 → 是否为修饰键 */
const _MODIFIER_NAMES = new Set([
  'CTRL',
  'CONTROL',
  'ALT',
  'OPTION',
  'SHIFT',
  'CMD',
  'COMMAND',
  'META',
  'SUPER',
])

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
  const { enabled = true, capture = false, target, ignoreRepeat = false } = options

  // 用 ref 持有最新的 shortcuts 列表，避免每次渲染都重新绑定监听
  const shortcutsRef = useRef(shortcuts)
  shortcutsRef.current = shortcuts

  // 按住的 accelerator 集合（hold 模式跟踪：keyup 时触发 onHoldEnd / 取消计时）
  const heldAccelerators = useRef(new Set<string>())
  // hold 定时器：accelerator → timer
  const holdTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  // hold 状态：accelerator → onHoldEnd + 物理 code（keyup 匹配用）
  const holdMetaRef = useRef(
    new Map<
      string,
      { accelerator: string; code?: string; onHoldEnd?: (event: KeyboardEvent) => void }
    >(),
  )
  /** 修饰键是否与 accelerator 声明一致（不比对主键；主键可由 code 锁定） */
  const modifiersMatch = useCallback((event: KeyboardEvent, accelerator: string) => {
    const parsed = parseAccelerator(accelerator)
    return (
      event.ctrlKey === parsed.ctrl &&
      event.altKey === parsed.alt &&
      event.shiftKey === parsed.shift &&
      event.metaKey === parsed.meta
    )
  }, [])

  // 稳定的 keydown 处理函数（依赖数组为空，引用永久稳定）
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // 长按自动重复：默认忽略；条目声明 allowRepeat 则放行（切标签连按/长按）
      const list = shortcutsRef.current
      for (const entry of list) {
        if (entry.enabled === false) continue
        if (ignoreRepeat && event.repeat && !entry.allowRepeat) continue
        if (entry.ignoreWhenTyping && isTypingTarget(event.target)) continue
        if (entry.code) {
          // 物理键锁定：只比 code + 修饰键（兼容布局下 event.key 漂移，如 ` / ~）
          if (event.code !== entry.code) continue
          if (!modifiersMatch(event, entry.accelerator)) continue
        } else if (!matchAccelerator(event, entry.accelerator)) {
          continue
        }

        console.log(
          '[shortcut-registry] matched:',
          entry.accelerator,
          'handler exists:',
          !!entry.handler,
        )

        // hold 模式：按住开始 + 计时触发；普通模式：立即触发
        if (entry.holdMs != null || entry.onHoldStart || entry.onHoldEnd) {
          if (!event.repeat) {
            heldAccelerators.current.add(entry.accelerator)
            holdMetaRef.current.set(entry.accelerator, {
              accelerator: entry.accelerator,
              code: entry.code,
              onHoldEnd: entry.onHoldEnd,
            })
            if (entry.onHoldStart) entry.onHoldStart(event)
          }
          if (entry.holdMs != null && !holdTimers.current.has(entry.accelerator)) {
            holdTimers.current.set(
              entry.accelerator,
              setTimeout(() => {
                holdTimers.current.delete(entry.accelerator)
                // 长按达标：触发 handler（一次）
                entry.handler?.(event)
              }, entry.holdMs),
            )
          }
          return
        }

        entry.handler?.(event)
        return
      }
    },
    [ignoreRepeat, modifiersMatch],
  )

  // keyup：hold 模式松开处理（code 优先，兼容 event.key 漂移；修饰键可能先松开）
  const handleKeyUp = useCallback((event: KeyboardEvent) => {
    const held = heldAccelerators.current
    if (held.size === 0) return
    const normKey = event.key.toLowerCase()
    for (const accelerator of Array.from(held)) {
      const meta = holdMetaRef.current.get(accelerator)
      const parsed = parseAccelerator(accelerator)
      const hit = meta?.code ? event.code === meta.code : parsed.key === normKey
      if (!hit) continue
      // 取消未达标的长按计时
      const timer = holdTimers.current.get(accelerator)
      if (timer) {
        clearTimeout(timer)
        holdTimers.current.delete(accelerator)
      }
      held.delete(accelerator)
      holdMetaRef.current.delete(accelerator)
      meta?.onHoldEnd?.(event)
      return
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    const node: EventTarget = target ?? window
    node.addEventListener('keydown', handleKeyDown as EventListener, capture)
    node.addEventListener('keyup', handleKeyUp as EventListener, capture)
    return () => {
      node.removeEventListener('keydown', handleKeyDown as EventListener, capture)
      node.removeEventListener('keyup', handleKeyUp as EventListener, capture)
      // 清理 hold 状态与计时器
      for (const timer of holdTimers.current.values()) clearTimeout(timer)
      holdTimers.current.clear()
      heldAccelerators.current.clear()
      holdMetaRef.current.clear()
    }
  }, [enabled, capture, target, handleKeyDown, handleKeyUp])
}
