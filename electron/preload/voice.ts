import { ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/types.js'

export const voiceApi = {
  // 语音识别
  stt: {
    // 测试 AI 接入配置连通性（设置页"测试连接"按钮调用）
    testAi: (input: { providerId: string }) => {
      return ipcRenderer.invoke(IPC_CHANNELS.VOICE_TEST_AI, input)
    },
    // 强制停止当前录音（preview 客户端兜底用：主进程 keyup 丢失时由 preview 主动调）
    forceStop: (reason: string) => ipcRenderer.invoke(IPC_CHANNELS.VOICE_FORCE_STOP, reason),
    // 麦克风设备列表
    updateInputDeviceList: (list: unknown[]) =>
      ipcRenderer.invoke(IPC_CHANNELS.VOICE_INPUT_DEVICES_UPDATE, list),
    refreshInputDevices: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_INPUT_DEVICES_REFRESH),
  },
  // 语音输入配置（enterToSend 等全局设置）
  voice: {
    getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_GET_CONFIG),
    setConfig: (patch: unknown) => ipcRenderer.invoke(IPC_CHANNELS.VOICE_SET_CONFIG, patch),
    // 底栏语音按钮触发：走后台语音路径，显示独立预览窗
    triggerStart: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_TRIGGER_START),
    triggerStop: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_TRIGGER_STOP),
    // v0.5.2 regress-2：测试 TTS 配置连通性（发送短文本合成请求，返回 audio dataURL）
    testTts: (input: { providerId: string }) => {
      return ipcRenderer.invoke(IPC_CHANNELS.VOICE_TEST_TTS, input)
    },
  },
  // 后台语音注入+发送（主→最近聚焦窗口渲染：背景路径识别完成后注入 AI 输入框）
  // 载荷：{ text, enterToSend }，由渲染层决定是否自动回车发送
  onVoiceInjectAndSend: (
    callback: (payload: { text: string; enterToSend: boolean }) => void,
  ) => {
    const handler = (
      _e: unknown,
      payload: { text: string; enterToSend: boolean },
    ) => callback(payload)
    ipcRenderer.on(IPC_CHANNELS.VOICE_INJECT_AND_SEND, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_INJECT_AND_SEND, handler)
  },
  // 预览窗更新（主→预览窗渲染）
  onPreviewUpdate: (
    callback: (payload: {
      text: string
      status: 'recording' | 'transcribing' | 'done' | 'sent'
    }) => void,
  ) => {
    const handler = (
      _e: unknown,
      payload: { text: string; status: 'recording' | 'transcribing' | 'done' | 'sent' },
    ) => callback(payload)
    ipcRenderer.on(IPC_CHANNELS.PREVIEW_UPDATE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PREVIEW_UPDATE, handler)
  },
  // 预览窗隐藏（主→预览窗渲染）
  onPreviewHide: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC_CHANNELS.PREVIEW_HIDE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PREVIEW_HIDE, handler)
  },
  // 渲染进程音频采集：开始录音（主→预览窗渲染）
  onVoiceRecordStart: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC_CHANNELS.VOICE_RECORD_START, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_RECORD_START, handler)
  },
  // 渲染进程音频采集：停止录音（主→预览窗渲染）
  onVoiceRecordStop: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC_CHANNELS.VOICE_RECORD_STOP, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_RECORD_STOP, handler)
  },
  // 渲染进程音频采集：回传 PCM 数据（预览窗渲染→主）
  sendVoiceRecordData: (data: number[]) => {
    ipcRenderer.send(IPC_CHANNELS.VOICE_RECORD_DATA, data)
  },
}
