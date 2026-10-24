// electron/modules/plugins/voice/config-store.ts — 语音输入（STT）配置存储
//
// 由 voice 插件独立拥有，持久化到 SQLite settings.db 的 voice_config 表
// （createSqliteJsonStore）。仅包含 STT、上屏行为与麦克风设备字段；
// TTS 字段由 ../tts/config-store.ts 的独立 tts_config 表负责。

import { createSqliteJsonStore } from '../../../store/module-state-store.js'
import type { VoiceSettings } from '../../../shared/api/voice.api.js'
export type { VoiceSettings } from '../../../shared/api/voice.api.js'

/** 语音输入配置默认值 */
export const VOICE_SETTINGS_DEFAULTS: VoiceSettings = {
  confirmMode: 'auto',
  inputMethod: 'layered',
  enterToSend: false,
  sttMode: 'ai',
  aiProvider: '',
  language: 'zh',
  inputDeviceId: '',
  inputDeviceList: [],
  localExePath: '',
  localArgs: '',
}

const STORAGE_VERSION = 2

const store = createSqliteJsonStore<{ config: VoiceSettings; version: number }>({
  tableName: 'voice_config',
  defaults: { config: VOICE_SETTINGS_DEFAULTS, version: STORAGE_VERSION },
})

/** 读取语音输入配置（自动合并默认值；旧表中遗留的 TTS 字段在此被忽略） */
export function getVoiceSettings(): VoiceSettings {
  const stored = (store.get('config') || {}) as Partial<VoiceSettings>
  return { ...VOICE_SETTINGS_DEFAULTS, ...stored }
}

/** 更新语音输入配置（合并 patch） */
export function updateVoiceSettings(patch: Partial<VoiceSettings>): VoiceSettings {
  const next: VoiceSettings = { ...getVoiceSettings(), ...patch }
  store.set('config', next)
  return next
}
