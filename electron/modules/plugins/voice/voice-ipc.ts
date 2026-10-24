// electron/modules/plugins/voice/voice-ipc.ts — 语音识别（STT）IPC 注册
//
// 包含渲染进程主动调用的 STT 控制 IPC：
//   - STT_START：开始录音识别
//   - STT_STOP：停止录音并返回识别文本
//   - VOICE_TRIGGER_START/STOP：底栏语音按钮触发，走后台语音路径（含独立预览窗）
//
// 注意：Alt+V 后台语音流程（预览窗、startBackgroundVoice/stopBackgroundVoice）
// 与 windowState 全局状态紧密耦合，保留在 background-voice.ts 中；
// 热键注册由 platform/hotkey 通过 deps 注入调用。
//
// 由 voice 插件的 init 调用 registerVoiceIpc(deps) 完成注册。
//
// 已迁移到统一注入管线：支持 EffectScope 管理 IPC handler 生命周期。

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../../shared/types.js'
import { updateVoiceSettings } from './config-store.js'
import type { SttEngine } from './stt/engine.js'
import type { AudioDeviceInfo } from '../../../shared/api.types.js'
import type { EffectScope } from '../../effect-scope.js'
import { markRecordingRendererReady } from './audio/capture.js'

/**
 * 校验 enumerateDevices 返回的设备对象，过滤掉非法项
 */
function isValidAudioDevice(d: unknown): d is AudioDeviceInfo {
  if (!d || typeof d !== 'object') return false
  const o = d as Record<string, unknown>
  return (
    typeof o.deviceId === 'string' &&
    typeof o.label === 'string' &&
    typeof o.groupId === 'string'
  )
}

/** 由模块接线注入的依赖（避免循环引用） */
export interface VoiceIpcDeps {
  sttEngine: SttEngine
  /** 触发后台语音录音（显示独立预览窗） */
  startBackgroundVoice: () => Promise<void>
  /** 停止后台语音录音并注入发送（隐藏预览窗） */
  stopBackgroundVoice: () => Promise<void>
}

/**
 * 注册语音识别相关 IPC handler。
 *
 * 已迁移到统一注入管线：支持 EffectScope 管理 IPC handler 生命周期。
 */
export function registerVoiceIpc(deps: VoiceIpcDeps, scope?: EffectScope): void {
  const { sttEngine, startBackgroundVoice, stopBackgroundVoice } = deps
  const ready = (event: Electron.IpcMainEvent) => {
    if (event.senderFrame === event.sender.mainFrame) markRecordingRendererReady(event.sender)
  }
  if (scope) scope.ipcOn(IPC_CHANNELS.VOICE_RECORD_READY, ready)
  else ipcMain.on(IPC_CHANNELS.VOICE_RECORD_READY, ready)

  // 辅助函数：根据是否有 scope 选择注册方式
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = scope
    ? (channel: string, fn: (...args: any[]) => any) => scope.ipcHandle(channel, fn as any)
    : (channel: string, fn: (...args: any[]) => any) => ipcMain.handle(channel, fn as any)

  handle(IPC_CHANNELS.STT_START, async () => {
    await sttEngine.start()
  })
  handle(IPC_CHANNELS.STT_STOP, async () => {
    return await sttEngine.stop()
  })

  /**
   * 测试当前 AI 接入配置连通性（用于设置页"测试连接"按钮）。
   * 发送 0.2s 静音 WAV，验证能拿到非空识别文本。
   */
  handle(
    IPC_CHANNELS.VOICE_TEST_AI,
    async (_e: unknown, input: { providerId: string }) => {
      try {
        return await sttEngine.testAiProvider(input.providerId)
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
      }
    },
  )

  // 底栏语音按钮触发：走后台语音路径，显示独立预览窗
  handle(IPC_CHANNELS.VOICE_TRIGGER_START, async () => {
    await startBackgroundVoice()
  })
  handle(IPC_CHANNELS.VOICE_TRIGGER_STOP, async () => {
    await stopBackgroundVoice()
  })

  /**
   * 渲染层（RecordIndicator 客户端）请求强制停止当前录音。
   * 用于主进程 keyup 丢失 / IPC 卡住 等异常情况下的兜底恢复。
   */
  handle(IPC_CHANNELS.VOICE_FORCE_STOP, async (_e: unknown, reason: string) => {
    console.warn(`[voice-ipc] 收到 forceStop 请求，原因: ${reason || '(未指定)'}`)
    try {
      await stopBackgroundVoice()
      return { ok: true, reason: 'stopped' }
    } catch (err) {
      console.error('[voice-ipc] forceStop 失败:', err)
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * 渲染层上报麦克风设备列表（enumerateDevices 结果）。
   * 主进程保存到 voice 配置的 inputDeviceList，供设置页 UI 展示。
   */
  handle(IPC_CHANNELS.VOICE_INPUT_DEVICES_UPDATE, async (_e: unknown, list: unknown[]) => {
    try {
      const safeList = Array.isArray(list) ? list.filter(isValidAudioDevice) : []
      await updateVoiceSettings({ inputDeviceList: safeList })
      console.info(`[voice-ipc] 已更新麦克风设备列表，共 ${safeList.length} 个设备`)
      return { ok: true, count: safeList.length }
    } catch (err) {
      console.error('[voice-ipc] 更新麦克风设备列表失败:', err)
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * 主进程请求渲染层重新枚举设备。
   */
  handle(IPC_CHANNELS.VOICE_INPUT_DEVICES_REFRESH, async () => {
    return { ok: true }
  })
}
