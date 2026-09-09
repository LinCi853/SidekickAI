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
import type { VoiceConfig } from '../shared/api/voice.api.js'

// 重新导出 VoiceConfig 类型（定义在 shared/api/voice.api.ts，供 default-config.ts 等使用）
export type { VoiceConfig }

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
