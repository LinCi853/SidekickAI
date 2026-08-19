// electron/modules/wiring/voice.ts — 语音输入模块接线（init / teardown / clearData）
//
// SttEngine 由本模块懒加载持有：模块未启用时主进程不创建、不运行任何语音相关代码
// （11.10 启动即隔离）。
//
// 已迁移到统一注入管线（EffectScope）。

import { IPC_CHANNELS } from '../../shared/types.js'
import { EffectScope } from '../effect-scope.js'
import { SttEngine } from '../../stt/engine.js'
import { registerVoiceIpc } from '../../ipc/voice-ipc.js'
import { registerVoiceConfigIPC, updateVoiceConfig } from '../../store/voice-store.js'
import {
  startBackgroundVoice as startBackgroundVoiceImpl,
  stopBackgroundVoice as stopBackgroundVoiceImpl,
  toggleVoiceRecording as toggleVoiceRecordingImpl,
} from '../../voice/background-voice.js'
import { hidePreview } from '../../voice/preview-window.js'
import { getHotkeyManagerInstance } from '../../hotkey/manager.js'

/** 模块级 EffectScope */
const scope = new EffectScope('voice', 'voice')

const VOICE_CHANNELS = [
  IPC_CHANNELS.STT_START,
  IPC_CHANNELS.STT_STOP,
  IPC_CHANNELS.VOICE_TEST_AI,
  IPC_CHANNELS.VOICE_TRIGGER_START,
  IPC_CHANNELS.VOICE_TRIGGER_STOP,
  IPC_CHANNELS.VOICE_FORCE_STOP,
  IPC_CHANNELS.VOICE_INPUT_DEVICES_UPDATE,
  IPC_CHANNELS.VOICE_INPUT_DEVICES_REFRESH,
  IPC_CHANNELS.VOICE_GET_CONFIG,
  IPC_CHANNELS.VOICE_SET_CONFIG,
]

let sttEngine: SttEngine | null = null

/** 获取/创建 SttEngine（语音模块启用后才应被调用） */
export function getSttEngine(): SttEngine {
  if (!sttEngine) sttEngine = new SttEngine()
  return sttEngine
}

/** 供 main.ts 退出清理使用（未启用时返回 null） */
export function peekSttEngine(): SttEngine | null {
  return sttEngine
}

/**
 * 语音热键注册同步（幂等）：模块启用 && 热键开关启用 → 注册；否则注销。
 * 调用点：registerHotkeyIpc 启动注册 / 模块运行期启用 init / 模块禁用 teardown。
 */
export function syncVoiceHotkeyRegistration(): void {
  const hm = getHotkeyManagerInstance()
  if (!hm) return
  // 先清掉旧注册（幂等前提）
  hm.voiceUnregisterFn?.()
  hm.voiceUnregisterFn = null
  if (sttEngine && hm.getEnabled('backgroundVoice')) {
    hm.voiceUnregisterFn = hm.registerVoiceHotkey(
      hm.getHotkey('backgroundVoice'),
      () => {
        void startBackgroundVoiceImpl(sttEngine!)
      },
      () => {
        void stopBackgroundVoiceImpl(sttEngine!)
      },
    )
    console.log('[wiring:voice] 语音热键已注册')
  } else {
    console.log('[wiring:voice] 语音模块未启用或热键已禁用，语音热键未注册')
  }
}

/** 热键回调（gated）：模块未启用时全部 no-op，保证 Alt+V 无法触发任何语音行为 */
export function startBackgroundVoiceGated(): Promise<void> {
  if (!sttEngine) return Promise.resolve()
  return startBackgroundVoiceImpl(sttEngine)
}
export function stopBackgroundVoiceGated(): Promise<void> {
  if (!sttEngine) return Promise.resolve()
  return stopBackgroundVoiceImpl(sttEngine)
}
export function toggleVoiceRecordingGated(): Promise<void> {
  if (!sttEngine) return Promise.resolve()
  return toggleVoiceRecordingImpl(sttEngine)
}

export function initVoiceModule(): void {
  // 幂等：先清理旧注册再注册（init 重入/热重载安全）
  void scope.dispose().then(() => {
    const engine = getSttEngine()
    // 运行期启用：注册语音热键（启动期由 registerHotkeyIpc 调用 sync，二者幂等）
    syncVoiceHotkeyRegistration()
    // 传递 scope 给 registerVoiceConfigIPC，使其使用 EffectScope 管理 IPC handler
    registerVoiceConfigIPC(scope)
    // 传递 scope 给 registerVoiceIpc，使其使用 EffectScope 管理 IPC handler
    registerVoiceIpc({
      sttEngine: engine,
      startBackgroundVoice: () => startBackgroundVoiceImpl(engine),
      stopBackgroundVoice: () => stopBackgroundVoiceImpl(engine),
    }, scope)
  })
}

export function teardownVoiceModule(): void {
  // 停止录音 + 隐藏预览窗 + 卸载通道
  if (sttEngine) {
    try {
      void stopBackgroundVoiceImpl(sttEngine)
    } catch (err) {
      console.warn('[wiring:voice] 停止录音失败:', err)
    }
  }
  try {
    hidePreview()
  } catch (err) {
    console.warn('[wiring:voice] 隐藏预览窗失败:', err)
  }
  // 注销语音热键（11.5 关闭残留清单）
  getHotkeyManagerInstance()?.voiceUnregisterFn?.()
  const hm = getHotkeyManagerInstance()
  if (hm) hm.voiceUnregisterFn = null
  void scope.dispose()
  sttEngine = null
}

export function clearVoiceData(): void {
  // 重置 STT 相关配置字段（保留 TTS 字段，由 tts 模块负责）
  updateVoiceConfig({
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
  })
  // 说明：whisper-cli 下载流程目前仅存在于 binary-resolver 的 URL 拼装，尚未实装下载；
  // 本地模式由用户自配可执行文件路径（localExePath），无内置资产需要清理。
  // 未来实装运行时下载时，必须在此注册资产清理（决策 0.4/11.6）。
  console.log('[wiring:voice] 数据已清除')
}
