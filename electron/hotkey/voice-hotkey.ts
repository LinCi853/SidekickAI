// electron/hotkey/voice-hotkey.ts — 语音热键（自 manager.ts 拆分的功能簇）
//
// 包含：注册/注销语音热键（Alt+V hold-to-record）、按下态维护与释放、
// keyup 丢失时的 500ms 轮询兜底。
// 全部为函数式实现：第一参数 host 为 HotkeyManager 实例，
// 通过 VoiceHost 协作接口访问 manager 的字段与方法。

import type { HotkeyOwnership, HotkeyLease } from '../../packages/desktop-common/hotkey-ownership.js'
import { parseAccelerator } from './accelerator.js'

/** 语音热键匹配器（独立于主映射，仅 uiohook keydown/keyup，不走 globalShortcut） */
export interface VoiceMatcher {
  lease: HotkeyLease
  keycode: number | null
  alt: boolean
  ctrl: boolean
  shift: boolean
  meta: boolean
  onKeyDown: () => void
  onKeyUp: () => void
}

/** 语音热键簇与 HotkeyManager 的协作接口：声明本模块用到的 manager 字段与方法 */
export interface VoiceHost {
  voiceCleanup: (() => void) | null
  voiceMatcher: VoiceMatcher | null
  /**
   * 语音热键「按下中」状态：记录 V 是否处于按下 + Alt 是否匹配。
   * 用于解决"先松 Alt 再松 V 时 keyup 严格匹配失败"的问题：
   *   - 严格匹配场景：用户先松 V 再松 Alt → V keyup 时 altKey=true 匹配成功
   *   - 严格匹配失败场景：用户先松 Alt 再松 V → V keyup 时 altKey=false 不匹配
   * 用"按下态"标记后：V keyup 时若处于 pressed 状态，无视当前 altKey 状态直接触发 onKeyUp。
   */
  voiceKeyPressed: boolean
  /**
   * 最近一次 V keydown 的时间戳（用于轮询检测"按键是否还在按"）。
   * OS 长按时会按 ~30-50ms 间隔重复发 keydown；用户真正松开后，OS 不再发 keydown。
   * 但 uiohook 在 Windows 上对 auto-repeat 的转发可能不完整（间隔远大于 OS 间隔），
   * 因此阈值不能太短，否则会把"长按中但 uiohook 暂未转发 repeat"误判为松开。
   * 当前阈值 1500ms：仅在 uiohook keyup 完全丢失且超过 1.5s 没有任何 keydown 时兜底。
   */
  voiceLastKeydownAt: number
  /** 500ms 轮询 timer id（兜底检测 keyup 丢失，阈值放宽避免误判 auto-repeat） */
  voicePollingTimer: ReturnType<typeof setInterval> | null
  ownership: HotkeyOwnership
  ownershipLeases: Map<string, HotkeyLease>
  registrationStates: Map<string, 'registered' | 'fallback' | 'conflict' | 'unavailable'>
  /** uiohook 是否已启动 */
  uiohookStarted: boolean
  /** Start the input hook once. */
  ensureUiohookStarted(): void
}

/**
 * 注册语音热键（Alt+V hold-to-record）
 *
 * 仅用 uiohook 监听 keydown/keyup（globalShortcut 不支持 keyup）。
 * 不进入 registered/uiohookMatchers 主映射，独立管理。
 *
 * @returns 注销函数（调用后停止监听）
 */
export function registerVoiceHotkey(
  host: VoiceHost,
  accelerator: string,
  onKeyDown: () => void,
  onKeyUp: () => void,
): () => void {
  host.voiceCleanup?.()
  const lease = host.ownership.acquire(accelerator, `voice:${accelerator}`)
  if (!lease) {
    host.registrationStates.set(accelerator, 'conflict')
    return () => {}
  }
  const parsed = parseAccelerator(accelerator)
  host.ensureUiohookStarted()
  if (!host.uiohookStarted || parsed.keycode == null) {
    lease.release()
    host.registrationStates.set(accelerator, 'unavailable')
    return () => {}
  }
  const matcher: VoiceMatcher = {
    lease,
    keycode: parsed.keycode,
    alt: parsed.alt,
    ctrl: parsed.ctrl,
    shift: parsed.shift,
    meta: parsed.meta,
    onKeyDown,
    onKeyUp,
  }
  host.voiceMatcher = matcher
  host.ownershipLeases.set(accelerator, lease)
  host.registrationStates.set(accelerator, 'registered')
  // 注册时清空按下态（避免上次未正确释放的残留状态）
  host.voiceKeyPressed = false
  host.voiceLastKeydownAt = 0
  stopVoicePolling(host)
  console.log(`[HotkeyManager] Voice shortcut registered: ${accelerator}`)
  const cleanup = () => {
    if (host.voiceMatcher !== matcher) return
    releaseVoiceHold(host)
    host.voiceMatcher = null
    host.voiceKeyPressed = false
    host.voiceLastKeydownAt = 0
    stopVoicePolling(host)
    lease.release()
    host.ownershipLeases.delete(accelerator)
    host.registrationStates.delete(accelerator)
    host.voiceCleanup = null
    console.log(`[HotkeyManager] 语音热键已注销: ${accelerator}`)
  }
  host.voiceCleanup = cleanup
  return cleanup
}

export function releaseVoiceHold(host: VoiceHost): void {
  if (!host.voiceKeyPressed) return
  host.voiceKeyPressed = false
  host.voiceLastKeydownAt = 0
  stopVoicePolling(host)
  try { host.voiceMatcher?.onKeyUp() }
  catch (error) { console.warn('[HotkeyManager] Voice release failed', error) }
}

/**
 * 启动 500ms 轮询：当 voiceKeyPressed=true 时，每 500ms 检查一次
 * "距上次 V keydown 是否超过 1500ms"：
 *   - 是 → 强制触发 onKeyUp（兜底：uiohook keyup 完全丢失）
 *   - 否 → 继续轮询
 *
 * 设计说明：
 *   - 主释放信号是 uiohook keyup 事件（用户松开按键时立即触发）
 *   - 轮询仅作 keyup 丢失兜底，阈值 1500ms 远大于 uiohook auto-repeat 间隔，
 *     避免把"长按中但 uiohook 暂未转发 repeat keydown"误判为松开
 *   - 同时处理"按下 V 但 uiohook 完全没收到 keydown"的情况：
 *     voiceKeyPressed 永远 false → 轮询不启动 → V keyup 兜底路径触发 onKeyUp
 */
export function startVoicePolling(host: VoiceHost): void {
  if (host.voicePollingTimer) return
  host.voicePollingTimer = setInterval(() => {
    if (!host.voiceKeyPressed) {
      stopVoicePolling(host)
      return
    }
    const now = Date.now()
    const elapsed = now - host.voiceLastKeydownAt
    // 阈值 1500ms：远大于 uiohook auto-repeat 间隔，仅兜底 keyup 完全丢失
    if (elapsed > 1500) {
      console.log(
        `[HotkeyManager] 轮询兜底：V 键 keyup 丢失（距上次 keydown ${elapsed}ms），强制触发 onKeyUp`,
      )
      host.voiceKeyPressed = false
      stopVoicePolling(host)
      if (host.voiceMatcher) {
        try {
          host.voiceMatcher.onKeyUp()
        } catch (err) {
          console.error('[HotkeyManager] 轮询 onKeyUp 异常:', err)
        }
      }
    }
  }, 500)
}

/** 停止轮询 */
export function stopVoicePolling(host: VoiceHost): void {
  if (host.voicePollingTimer) {
    clearInterval(host.voicePollingTimer)
    host.voicePollingTimer = null
  }
}
