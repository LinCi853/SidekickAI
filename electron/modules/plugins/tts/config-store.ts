// electron/modules/plugins/tts/config-store.ts — 语音合成（TTS）配置存储
//
// 由 tts 插件独立拥有，持久化到 SQLite settings.db 的 tts_config 表。
// 旧版本把 ttsMode/ttsProvider 与 STT 字段一起存在 voice_config 表；首次读取
// 时从旧表复制一次并记录迁移标记，之后只读写 tts_config。

import { createSqliteJsonStore } from '../../../store/module-state-store.js'
import type { TtsSettings, VoiceConfig } from '../../../shared/api/voice.api.js'

/** TTS 配置默认值 */
export const TTS_SETTINGS_DEFAULTS: TtsSettings = {
  ttsMode: 'disable',
  ttsProvider: '',
}

const store = createSqliteJsonStore<{
  config: TtsSettings
  version: number
  migratedFromVoice?: boolean
}>({
  tableName: 'tts_config',
  defaults: { config: TTS_SETTINGS_DEFAULTS, version: 1 },
})

/** 读取旧版 voice_config（仅迁移时使用） */
function readLegacyVoiceConfig(): Partial<VoiceConfig> | undefined {
  const legacy = createSqliteJsonStore<{ config: Partial<VoiceConfig> }>({
    tableName: 'voice_config',
    defaults: { config: {} },
  })
  return legacy.get('config') as Partial<VoiceConfig> | undefined
}

/** 一次性迁移：把旧 voice_config 中的 TTS 字段复制到 tts_config */
function migrateLegacySettings(): void {
  if (store.has('migratedFromVoice')) return
  try {
    const legacy = readLegacyVoiceConfig()
    if (legacy?.ttsMode !== undefined || legacy?.ttsProvider !== undefined) {
      store.set('config', {
        ttsMode: legacy.ttsMode ?? TTS_SETTINGS_DEFAULTS.ttsMode,
        ttsProvider: legacy.ttsProvider ?? TTS_SETTINGS_DEFAULTS.ttsProvider,
      })
    }
  } catch (err) {
    console.warn('[tts-config] 迁移旧 voice_config 失败，使用默认配置:', err)
  }
  store.set('migratedFromVoice', true)
}

/** 读取 TTS 配置（首次读取时迁移旧 voice_config 中的 TTS 字段） */
export function getTtsSettings(): TtsSettings {
  migrateLegacySettings()
  const stored = (store.get('config') || {}) as Partial<TtsSettings>
  return { ...TTS_SETTINGS_DEFAULTS, ...stored }
}

/** 更新 TTS 配置（合并 patch） */
export function updateTtsSettings(patch: Partial<TtsSettings>): TtsSettings {
  const next: TtsSettings = { ...getTtsSettings(), ...patch }
  store.set('config', next)
  return next
}
