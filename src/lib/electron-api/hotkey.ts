/* =====================================================================
   lib/electron-api/hotkey.ts —— 全局热键
   ===================================================================== */

import type { HotkeyAction, HotkeyConfig } from '../../../electron/shared/types'
import { requireElectron } from './core'

/* =====================================================================
   全局热键 —— 对应 window.electron.hotkey
   ===================================================================== */

/** 注册全局热键（accelerator 如 'CommandOrControl+Space'） */
export async function registerHotkey(accelerator: string, callback: () => void): Promise<boolean> {
  const api = requireElectron()
  return api.hotkey.register(accelerator, callback)
}

/** 注销全局热键 */
export async function unregisterHotkey(accelerator: string): Promise<void> {
  const api = requireElectron()
  return api.hotkey.unregister(accelerator)
}

/** 获取全部内置热键配置（供 UI 展示） */
export async function getHotkeys(): Promise<HotkeyConfig[]> {
  const api = requireElectron()
  return api.hotkey.getAll()
}

/**
 * 设置某个内置热键（注销旧热键，注册新热键并持久化）。
 * @returns 是否注册成功（失败时主进程会恢复旧热键）
 */
export async function setHotkeyFor(action: HotkeyAction, accelerator: string): Promise<boolean> {
  const api = requireElectron()
  return api.hotkey.set(action, accelerator)
}

/**
 * 启用/禁用某个内置热键（独立开关）。
 * 禁用时主进程注销当前 accelerator；启用时主进程重新注册；持久化到 hotkey.json。
 */
export async function setHotkeyEnabled(action: HotkeyAction, enabled: boolean): Promise<void> {
  const api = requireElectron()
  return api.hotkey.setEnabled(action, enabled)
}

/**
 * 开始录制热键（主进程通过 globalShortcut 捕获按键，能检测系统占用的 Alt+key 组合）。
 * 录制结果通过 `onHotkeyRecordingResult` 监听。
 * @returns 是否成功进入录制状态
 */
export async function startHotkeyRecording(): Promise<boolean> {
  const api = requireElectron()
  return api.hotkey.startRecording()
}

/** 停止录制热键 */
export async function stopHotkeyRecording(): Promise<void> {
  const api = requireElectron()
  return api.hotkey.stopRecording()
}

/**
 * 唤出键冲突定位：返回可能的占用者候选（进程 + 置信分级 + 怀疑理由 + 处置指引），
 * 供设置页在系统注册失败时展示「被谁占用、怎么处理」。打开检测即先尝试即时接管。
 */
export async function scanHotkeyConflict(accelerator: string): Promise<{
  accelerator: string
  systemRegistered: boolean
  candidates: Array<{
    pid: number
    name: string
    instances: number
    confidence: 'high' | 'medium' | 'low'
    reason: string
    hint: string | null
  }>
}> {
  const api = requireElectron()
  return api.hotkey.conflictScan(accelerator)
}

/**
 * 设置唤出键接管策略：'takeover'=占用者退出后自动接管系统注册；
 * 'compat'=只用钩子兼容模式；null=下次注册时重新询问。
 */
export async function setHotkeyTakeoverChoice(
  choice: 'takeover' | 'compat' | null,
): Promise<boolean> {
  const api = requireElectron()
  return api.hotkey.takeoverSet(choice)
}

/**
 * 监听热键录制结果（主进程 → 渲染层：录制完成后通知）。
 * @returns 取消监听函数
 */
export function onHotkeyRecordingResult(
  callback: (result: { accelerator: string; reason?: string }) => void,
): () => void {
  const api = requireElectron()
  return api.hotkey.onRecordingResult(callback)
}

/**
 * 订阅热键录制实时反馈（主进程 → 渲染层：每次按键时推送当前修饰键+按键组合）。
 * 用于录制 UI 实时显示用户按下的组合，无需等到最终键按下。
 * @returns 取消监听函数
 */
export function onHotkeyRecordingPartial(
  callback: (partial: { modifiers: string[]; key: string | null }) => void,
): () => void {
  const api = requireElectron()
  return api.hotkey.onRecordingPartial(callback)
}
