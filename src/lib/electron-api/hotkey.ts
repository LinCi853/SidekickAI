/* =====================================================================
   lib/electron-api/hotkey.ts —— 全局热键
   ===================================================================== */

import type { HotkeyAction, HotkeyConfig } from '../../../electron/shared/types';
import { requireElectron } from './core';

/* =====================================================================
   全局热键 —— 对应 window.electron.hotkey
   ===================================================================== */

/** 注册全局热键（accelerator 如 'CommandOrControl+Space'） */
export async function registerHotkey(accelerator: string, callback: () => void): Promise<boolean> {
  const api = requireElectron();
  return api.hotkey.register(accelerator, callback);
}

/** 注销全局热键 */
export async function unregisterHotkey(accelerator: string): Promise<void> {
  const api = requireElectron();
  return api.hotkey.unregister(accelerator);
}

/** 获取全部内置热键配置（供 UI 展示） */
export async function getHotkeys(): Promise<HotkeyConfig[]> {
  const api = requireElectron();
  return api.hotkey.getAll();
}

/**
 * 设置某个内置热键（注销旧热键，注册新热键并持久化）。
 * @returns 是否注册成功（失败时主进程会恢复旧热键）
 */
export async function setHotkeyFor(action: HotkeyAction, accelerator: string): Promise<boolean> {
  const api = requireElectron();
  return api.hotkey.set(action, accelerator);
}

/**
 * 启用/禁用某个内置热键（独立开关）。
 * 禁用时主进程注销当前 accelerator；启用时主进程重新注册；持久化到 hotkey.json。
 */
export async function setHotkeyEnabled(action: HotkeyAction, enabled: boolean): Promise<void> {
  const api = requireElectron();
  return api.hotkey.setEnabled(action, enabled);
}

/**
 * 开始录制热键（主进程通过 globalShortcut 捕获按键，能检测系统占用的 Alt+key 组合）。
 * 录制结果通过 `onHotkeyRecordingResult` 监听。
 * @returns 是否成功进入录制状态
 */
export async function startHotkeyRecording(): Promise<boolean> {
  const api = requireElectron();
  return api.hotkey.startRecording();
}

/** 停止录制热键 */
export async function stopHotkeyRecording(): Promise<void> {
  const api = requireElectron();
  return api.hotkey.stopRecording();
}

/**
 * 监听热键录制结果（主进程 → 渲染层：录制完成后通知）。
 * @returns 取消监听函数
 */
export function onHotkeyRecordingResult(
  callback: (result: { accelerator: string; reason?: string }) => void,
): () => void {
  const api = requireElectron();
  return api.hotkey.onRecordingResult(callback);
}

/**
 * 订阅热键录制实时反馈（主进程 → 渲染层：每次按键时推送当前修饰键+按键组合）。
 * 用于录制 UI 实时显示用户按下的组合，无需等到最终键按下。
 * @returns 取消监听函数
 */
export function onHotkeyRecordingPartial(
  callback: (partial: { modifiers: string[]; key: string | null }) => void,
): () => void {
  const api = requireElectron();
  return api.hotkey.onRecordingPartial(callback);
}
