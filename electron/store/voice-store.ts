// electron/store/voice-store.ts — 语音输入配置持久化存储 + IPC 注册
//
// 持久化到 SQLite settings.db（voice_config 表，createSqliteJsonStore）。
// 字段：
//   - enterToSend: boolean  后台语音快速输入后是否自动回车发送（默认 false）
//   - sttMode: 识别引擎模式 ai/local（默认 ai）
//   - aiProvider/ttsProvider: 自定义 AI 接入（存储 provider UUID）
//   - localExePath/localArgs: 自定义本地识别软件
//
// 主窗口与自定义对话窗口共用同一份配置（全局设置）。
//
// 已迁移到统一注入管线：支持 EffectScope 管理 IPC handler 生命周期。

import { ipcMain } from 'electron'
import type { EffectScope } from '../modules/effect-scope.js'
import { IPC_CHANNELS, type AudioDeviceInfo } from '../shared/types.js'
import { createSqliteJsonStore } from './module-state-store.js'
import { VOICE_CONFIG } from './default-config.js'

// 持久化存储实例（写入 voice-config.json）
// 开发环境：写入项目内 .app-data/ 目录，规避 TRAE 沙箱对 AppData\Roaming 的写入限制
// 生产环境：使用默认 userData 路径
export interface VoiceConfig {
  /**
   * 语音识别完成后的上屏方式：
   * - 'auto'（默认）：识别完成后自动注入/粘贴上屏（前台注入 webview，后台 Ctrl+V 粘贴）
   * - 'clipboard'：仅写入剪贴板，不模拟按键（用户手动粘贴）
   */
  confirmMode: 'auto' | 'clipboard'
  /**
   * 后台语音上屏模式（仅影响应用外的第三方应用）：
   * - 'layered'（推荐）：分层降级 UI Automation → SendInput → 剪贴板
   * - 'clipboard'：剪贴板 + Ctrl+V 粘贴（会临时覆盖剪贴板，但兼容性好）
   * - 'type'：逐字符键入（不修改剪贴板，更可靠，但对某些应用可能有兼容性问题）
   */
  inputMethod: 'layered' | 'clipboard' | 'type'
  /** 前台注入后是否自动回车发送（后台粘贴场景不受此字段影响，粘贴即结束） */
  enterToSend: boolean
  /** 识别引擎模式 */
  sttMode: 'ai' | 'local'
  /** AI 接入：服务商协议（存储 provider UUID） */
  aiProvider: string
  /**
   * 识别语言提示（仅影响 AI 接入类引擎）。
   * - 'zh'：中文（默认）
   * - 'en'：英文
   * - 'auto'：由模型自动判断
   * - 其他 ISO 639-1 简写（如 'ja'、'ko'、'fr'）
   * 注意：该字段不强制翻译行为，只是给模型的提示词；模型可能仍按原语种转写。
   */
  language: string
  /**
   * 麦克风设备 ID（getUserMedia 的 deviceId）。
   * 空字符串 = 使用系统默认麦克风。
   * 由渲染层 enumerateDevices 获得，持久化后下次录音直接用。
   */
  inputDeviceId: string
  /**
   * 麦克风设备列表缓存（最近一次 enumerateDevices 结果）。
   * 用于设置页 UI 展示下拉选项。
   * - deviceId：getUserMedia / enumerateDevices 的 deviceId
   * - label：设备显示名（系统给的名字，如 "Realtek Audio (Microphone)"）
   * - groupId：同组设备 ID（同一物理设备的 input/output 共用 groupId）
   */
  inputDeviceList: AudioDeviceInfo[]
  /** 本地识别：可执行文件路径 */
  localExePath: string
  /** 本地识别：启动参数 */
  localArgs: string
  // ===== v0.5.2 regress-2：TTS（语音合成）独立配置 =====
  /** TTS 引擎模式：disable=关闭 / ai=自定义 AI 接入 */
  ttsMode?: 'disable' | 'ai'
  /** TTS 服务商标识（独立存储，存储 provider UUID） */
  ttsProvider?: string
}

// VOICE_CONFIG 已迁移到 default-config.ts

const store = createSqliteJsonStore<{ config: VoiceConfig; version: number }>({
  tableName: 'voice_config',

  defaults: {
    config: VOICE_CONFIG,
    version: 2,
  },
})

/** 读取语音配置（自动合并默认值，确保所有字段都存在） */
export function getVoiceConfig(): VoiceConfig {
  const stored = (store.get('config') || {}) as Partial<VoiceConfig>
  return { ...VOICE_CONFIG, ...stored }
}

/** 更新语音配置（合并 patch） */
export function updateVoiceConfig(patch: Partial<VoiceConfig>): VoiceConfig {
  const current = store.get('config')
  const next: VoiceConfig = { ...current, ...patch }
  store.set('config', next)
  return next
}

/**
 * 注册语音配置 IPC 处理器。
 *
 * 已迁移到统一注入管线：支持 EffectScope 管理 IPC handler 生命周期。
 */
export function registerVoiceConfigIPC(scope?: EffectScope): void {
  // 辅助函数：根据是否有 scope 选择注册方式
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = scope
    ? (channel: string, fn: (...args: any[]) => any) => scope.ipcHandle(channel, fn as any)
    : (channel: string, fn: (...args: any[]) => any) => ipcMain.handle(channel, fn as any)

  handle(IPC_CHANNELS.VOICE_GET_CONFIG, () => getVoiceConfig())
  handle(IPC_CHANNELS.VOICE_SET_CONFIG, (_e: unknown, patch: Partial<VoiceConfig>) =>
    updateVoiceConfig(patch),
  )
}
