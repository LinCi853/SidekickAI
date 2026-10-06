// electron/hotkey/recording.ts — 热键录制（自 manager.ts 拆分的功能簇）
//
// 包含：开始/停止录制、录制期 uiohook keydown 处理、录制结束恢复、
// uiohook keycode → Electron 键名反向映射（仅录制簇使用）。
// 全部为函数式实现：第一参数 host 为 HotkeyManager 实例，
// 通过 RecordingHost 协作接口访问 manager 的字段与方法。

import { globalShortcut } from 'electron'
import type { HotkeyOwnership, HotkeyLease } from '../../packages/desktop-common/hotkey-ownership.js'
import { checkSystemHotkeyConflict } from '../shared/system-hotkeys.js'
import { UiohookKey } from './uiohook.js'
import type { HotkeyInputState } from './input-state.js'
import type {
  HotkeyRecordingCallback,
  HotkeyPartialCallback,
  UiohookEvent,
} from './types.js'

/** 录制簇与 HotkeyManager 的协作接口：声明本模块用到的 manager 字段与方法 */
export interface RecordingHost {
  ownership: HotkeyOwnership
  recordingLeases: Map<string, HotkeyLease>
  inputState: HotkeyInputState
  /** accelerator -> 回调（已注册项，含 globalShortcut 与 uiohook 兜底） */
  registered: Map<string, () => void>
  /** 浏览器窗口快捷键 accelerator -> 回调（C4：scope='global' 的浏览器快捷键，独立跟踪） */
  browserShortcuts: Map<string, () => void>
  /** uiohook 是否已启动 */
  uiohookStarted: boolean
  /** 暂停状态：true 时跳过所有全局热键匹配（如使用指南窗口打开时） */
  _paused: boolean
  /** 热键录制状态：null 表示未录制，非 null 表示录制中（含回调） */
  _recordingCallback: HotkeyRecordingCallback | null
  /** 录制实时反馈回调（每次按键时调用，用于 UI 显示当前组合） */
  _recordingPartialCallback: HotkeyPartialCallback | null
  /** 录制期间临时注册的抑制器 accelerator 列表（用于阻止系统菜单等） */
  _recordingSuppressors: string[]
  /** 释放语音热键按下态（跨簇协作，见 voice-hotkey.ts） */
  releaseVoiceHold(): void
  /** Start the input hook once. */
  ensureUiohookStarted(): void
  restoreShortcutRegistrations(): void
}

/** uiohook keycode → Electron accelerator 主键名的反向映射 */
const _uiohookKeyToName = new Map<number, string>()

/** 构建 uiohook keycode → Electron 键名的反向映射 */
export function buildUiohookKeyMap(): void {
  // 字母 A-Z
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(65 + i)
    const kc = UiohookKey[letter as keyof typeof UiohookKey]
    if (typeof kc === 'number') _uiohookKeyToName.set(kc, letter)
  }
  // 数字 0-9
  for (let i = 0; i <= 9; i++) {
    const kc = UiohookKey[String(i) as keyof typeof UiohookKey]
    if (typeof kc === 'number') _uiohookKeyToName.set(kc, String(i))
  }
  // 功能键 F1-F24
  for (let i = 1; i <= 24; i++) {
    const fname = `F${i}`
    const kc = UiohookKey[fname as keyof typeof UiohookKey]
    if (typeof kc === 'number') _uiohookKeyToName.set(kc, fname)
  }
  // 特殊键
  const specialMap: Array<[string, string]> = [
    ['Space', 'Space'], ['Enter', 'Enter'], ['Escape', 'Esc'], ['Tab', 'Tab'],
    ['Backspace', 'Backspace'], ['Delete', 'Delete'], ['Insert', 'Insert'],
    ['Home', 'Home'], ['End', 'End'], ['PageUp', 'PageUp'], ['PageDown', 'PageDown'],
    ['ArrowUp', 'Up'], ['ArrowDown', 'Down'], ['ArrowLeft', 'Left'], ['ArrowRight', 'Right'],
    ['Equal', '='], ['Minus', '-'], ['Comma', ','], ['Period', '.'],
    ['Slash', '/'], ['Semicolon', ';'], ['Quote', "'"], ['Backquote', '`'],
    ['BracketLeft', '['], ['BracketRight', ']'], ['Backslash', '\\'],
  ]
  for (const [uk, name] of specialMap) {
    const kc = UiohookKey[uk]
    if (typeof kc === 'number') _uiohookKeyToName.set(kc, name)
  }
}

/**
 * 开始录制热键。
 * 使用 uiohook（系统级键盘钩子）捕获按键，能可靠检测 Alt+Space 等被系统拦截的组合。
 * 临时注册常见系统快捷键作为抑制器（空回调），阻止系统菜单弹出。
 * 通过 globalShortcut.register 检测所有应用（含外部应用）的占用情况。
 * @returns 是否成功进入录制状态
 */
export async function startRecording(
  host: RecordingHost,
  callback: HotkeyRecordingCallback,
  onPartial?: HotkeyPartialCallback,
): Promise<boolean> {
  if (host._recordingCallback) {
    stopRecording(host)
  }
  host.releaseVoiceHold()
  host.inputState.suspend()
  host._recordingCallback = callback
  host._recordingPartialCallback = onPartial ?? null

  // 启动 uiohook（录制依赖系统级键盘监听）
  host.ensureUiohookStarted()
  if (!host.uiohookStarted) {
    host._recordingCallback = null
    host._recordingPartialCallback = null
    return false
  }

  // 临时将本应用已注册的 globalShortcut 热键替换为空回调抑制器，
  // 防止录制期间触发原有功能（如 Alt+Space 切换窗口）
  for (const [acc, cb] of [...host.registered, ...host.browserShortcuts]) {
    const lease = host.ownership.retain(acc)
    if (!lease) continue
    try {
      if (globalShortcut.isRegistered(acc)) {
        globalShortcut.unregister(acc)
        const ok = globalShortcut.register(acc, () => {})
        if (ok) {
          host._recordingSuppressors.push(acc)
          host.recordingLeases.set(acc, lease)
        } else {
          // 重新注册失败则恢复原回调
          globalShortcut.register(acc, cb)
        }
      }
    } catch {
      // 忽略
    }
    if (!host.recordingLeases.has(acc)) lease.release()
  }

  // 临时注册常见 Windows 系统快捷键作为抑制器，阻止系统菜单/窗口操作弹出
  const systemSuppressors = [
    'Alt+Space', 'Alt+F4', 'Alt+Esc',
    'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  ]
  for (const supAcc of systemSuppressors) {
    let lease
    try {
      // 跳过已被本录制流程注册为抑制器的（含上面从 registered 替换的）
      if (host._recordingSuppressors.includes(supAcc)) continue
      // 跳过已被其他应用/进程注册的
      if (globalShortcut.isRegistered(supAcc)) continue
      lease = host.ownership.retain(supAcc) || host.ownership.acquire(supAcc, `recording-suppressor:${supAcc}`)
      if (!lease) continue
      const ok = globalShortcut.register(supAcc, () => {})
      if (ok) {
        host._recordingSuppressors.push(supAcc)
        host.recordingLeases.set(supAcc, lease)
      }
    } catch {
      // ignore
    }
    if (!host.recordingLeases.has(supAcc)) lease?.release()
  }

  return true
}

/** 停止录制热键 */
export function stopRecording(host: RecordingHost): void {
  restoreAfterRecording(host)
}

/**
 * 处理录制模式下的 uiohook keydown 事件。
 * 从 uiohook 事件构建 accelerator 字符串，检测可用性后通知回调。
 */
export function handleRecordingKeydown(host: RecordingHost, e: UiohookEvent): void {
  // 实时反馈：在任何过滤之前，发送当前按键状态给渲染层
  if (host._recordingPartialCallback) {
    const partialMods: string[] = []
    if (e.ctrlKey) partialMods.push('Ctrl')
    if (e.altKey) partialMods.push('Alt')
    if (e.shiftKey) partialMods.push('Shift')
    if (e.metaKey) partialMods.push('Meta')
    const partialKeyName = _uiohookKeyToName.get(e.keycode)
    // 修饰键自身按下时，不重复显示为 key
    const isModifierKey = ['Ctrl', 'Alt', 'Shift', 'Meta', 'Super'].includes(partialKeyName || '')
    host._recordingPartialCallback({
      modifiers: partialMods,
      key: isModifierKey || !partialKeyName ? null : partialKeyName,
    })
  }

  // 仅修饰键，等待下一个按键
  const keyName = _uiohookKeyToName.get(e.keycode)
  if (!keyName) return
  if (!host.inputState.matches({ keycode: e.keycode, ...host.inputState.modifiers })) return

  // Escape 取消录制（仅无修饰键时）
  if (keyName === 'Esc' && !e.ctrlKey && !e.altKey && !e.metaKey) {
    finishRecording(host, '')
    return
  }

  // 必须至少包含 Ctrl/Alt/Meta
  if (!e.ctrlKey && !e.altKey && !e.metaKey) return

  const accParts: string[] = []
  if (e.ctrlKey) accParts.push('Ctrl')
  if (e.altKey) accParts.push('Alt')
  if (e.shiftKey) accParts.push('Shift')
  if (e.metaKey) accParts.push('Meta')
  accParts.push(keyName)
  const accelerator = accParts.join('+')
  const lease = host.ownership.retain(accelerator) || host.ownership.acquire(accelerator, `recording-probe:${accelerator}`)
  if (!lease) {
    finishRecording(host, accelerator, '此快捷键由另一个工百窗实例使用，请换一个组合。')
    return
  }

  // 检测可用性：尝试 globalShortcut.register
  // 如果被我们的抑制器注册了（临时阻止系统菜单的空回调），先注销再试
  let reason: string | undefined
  const isSuppressed = host._recordingSuppressors.includes(accelerator)
  try {
    if (isSuppressed) {
      globalShortcut.unregister(accelerator)
    }
    // 尝试全局注册：成功 = 无其他应用占用；失败 = 被系统或其他应用占用
    const regOk = globalShortcut.register(accelerator, () => {})
    if (regOk) {
      globalShortcut.unregister(accelerator)
      // 重新注册抑制器（继续阻止系统菜单直到录制结束）
      if (isSuppressed) {
        globalShortcut.register(accelerator, () => {})
      }
    } else {
      const sysConflict = checkSystemHotkeyConflict(accelerator)
      reason = sysConflict
        ? `快捷键 ${accelerator} 与系统快捷键「${sysConflict.label}」冲突，请换一个组合`
        : `快捷键 ${accelerator} 已被系统或其他应用占用，请换一个组合`
      // 重新注册抑制器
      if (isSuppressed) {
        globalShortcut.register(accelerator, () => {})
      }
    }
  } catch (err) {
    reason = `快捷键 ${accelerator} 格式不支持（${err instanceof Error ? err.message : String(err)}）`
    if (isSuppressed) {
      try { globalShortcut.register(accelerator, () => {}) } catch {}
    }
  } finally {
    lease.release()
  }

  finishRecording(host, accelerator, reason)
}

/** 完成录制（成功或失败） */
export function finishRecording(host: RecordingHost, accelerator: string, reason?: string): void {
  const cb = host._recordingCallback
  restoreAfterRecording(host)
  if (cb) {
    cb({ accelerator, reason })
  }
}

/** 录制结束后恢复：注销所有抑制器，恢复原有热键回调 */
export function restoreAfterRecording(host: RecordingHost): void {
  if (!host._recordingCallback && host._recordingSuppressors.length === 0) return
  host.inputState.suspend()
  // 注销所有抑制器
  for (const supAcc of host._recordingSuppressors) {
    try { globalShortcut.unregister(supAcc) } catch { /* ignore */ }
  }
  for (const lease of host.recordingLeases.values()) lease.release()
  host.recordingLeases.clear()
  host._recordingSuppressors = []
  host._recordingCallback = null
  host._recordingPartialCallback = null
  host.restoreShortcutRegistrations()
}
