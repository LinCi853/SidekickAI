// electron/voice-config-ipc.ts — voice + tts 合并配置 IPC（装配层）
//
// 渲染层仍通过单一的 voice:getConfig / voice:setConfig 读写合并视图；
// 主进程按字段归属路由到 voice / tts 两个插件各自的配置存储。

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from './shared/types.js'
import type { EffectScope } from './modules/effect-scope.js'
import {
  getVoiceSettings,
  updateVoiceSettings,
  type VoiceSettings,
} from './modules/plugins/voice/config-store.js'
import { getTtsSettings, updateTtsSettings } from './modules/plugins/tts/config-store.js'
import type { VoiceConfig } from './shared/api/voice.api.js'

/** 合并读取 voice 与 tts 两份配置 */
export function getVoiceConfig(): VoiceConfig {
  const tts = getTtsSettings()
  return { ...getVoiceSettings(), ttsMode: tts.ttsMode, ttsProvider: tts.ttsProvider }
}

/** 合并更新：按字段归属分别写入 voice / tts 存储 */
export function updateVoiceConfig(patch: Partial<VoiceConfig>): VoiceConfig {
  const { ttsMode, ttsProvider, ...voicePatch } = patch
  if (Object.keys(voicePatch).length > 0) {
    updateVoiceSettings(voicePatch as Partial<VoiceSettings>)
  }
  if (ttsMode !== undefined || ttsProvider !== undefined) {
    updateTtsSettings({
      ...(ttsMode !== undefined ? { ttsMode } : {}),
      ...(ttsProvider !== undefined ? { ttsProvider } : {}),
    })
  }
  return getVoiceConfig()
}

/**
 * 注册合并配置 IPC（启动时无条件注册，供设置页跨模块读写）。
 *
 * 已迁移到统一注入管线：支持 EffectScope 管理 IPC handler 生命周期。
 */
export function registerVoiceConfigIPC(scope?: EffectScope): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = scope
    ? (channel: string, fn: (...args: any[]) => any) => scope.ipcHandle(channel, fn as any)
    : (channel: string, fn: (...args: any[]) => any) => ipcMain.handle(channel, fn as any)

  handle(IPC_CHANNELS.VOICE_GET_CONFIG, () => getVoiceConfig())
  handle(IPC_CHANNELS.VOICE_SET_CONFIG, (_e: unknown, patch: Partial<VoiceConfig>) =>
    updateVoiceConfig(patch),
  )
}
