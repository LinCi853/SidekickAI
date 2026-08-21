// voice.api.ts — Stt / VoiceConfig / AudioDevice 接口

/** 测试 AI 接入返回结果 */
export interface TestAiProviderResult {
  ok: boolean
  message: string
  text?: string
}

/** 测试 TTS 接入返回结果 */
export interface TestTtsResult {
  ok: boolean
  message: string
  audioDataUrl?: string
}

/** 语音识别接口 */
export interface SttAPI {
  /** 测试 AI 接入配置连通性（设置页"测试连接"按钮调用） */
  testAi: (input: { providerId: string }) => Promise<TestAiProviderResult>
  /**
   * 强制停止当前录音（preview 客户端兜底用：主进程 keyup 丢失时由 preview 主动调）
   * @param reason 调用原因，便于日志追踪
   */
  forceStop: (reason: string) => Promise<{ ok: boolean; reason?: string }>
  /** 上报麦克风设备列表到主进程（保存到 voice-config.inputDeviceList） */
  updateInputDeviceList: (list: unknown[]) => Promise<{ ok: boolean; count?: number; reason?: string }>
  /** 请求渲染层重新枚举设备 */
  refreshInputDevices: () => Promise<{ ok: boolean }>
}

/** 语音识别引擎模式 */
export type SttEngineMode = 'ai' | 'local'

/**
 * 麦克风/音频输入设备信息（来自 navigator.mediaDevices.enumerateDevices）。
 * - deviceId：getUserMedia / enumerateDevices 的设备 ID（每次浏览器启动可能不同）
 * - label：系统给的名字（如 "Realtek Audio (Microphone)"），未授权时为空字符串
 * - groupId：同物理设备的 input/output 共用 groupId
 */
export interface AudioDeviceInfo {
  deviceId: string
  label: string
  groupId: string
}

/** 语音输入配置（引擎选择 + 后台发送行为等全局设置） */
export interface VoiceConfig {
  /**
   * 语音识别完成后的上屏方式：
   * - 'auto'（默认）：识别完成后自动注入/粘贴上屏
   * - 'clipboard'：仅写入剪贴板，不模拟按键（用户手动粘贴）
   */
  confirmMode: 'auto' | 'clipboard'
  /**
   * 后台语音上屏模式（仅影响应用外的第三方应用）：
   * - 'layered'（推荐）：分层降级 UI Automation → SendInput → 剪贴板
   * - 'clipboard'：剪贴板 + Ctrl+V 粘贴
   * - 'type'：逐字符键入
   */
  inputMethod: 'layered' | 'clipboard' | 'type'
  /** 前台注入后是否自动回车发送（后台粘贴场景不受此字段影响） */
  enterToSend: boolean
  /** 识别引擎模式：ai=自定义AI接入 / local=本地识别软件 */
  sttMode: SttEngineMode
  /** AI 接入：服务商协议（存储 provider UUID） */
  aiProvider: string
  /**
   * 识别语言提示（仅影响 AI 接入类引擎）。
   * - 'zh'：中文（默认）
   * - 'en'：英文
   * - 'auto'：由模型自动判断
   * - 其他 ISO 639-1 简写
   */
  language: string
  /**
   * 麦克风设备 ID（getUserMedia 的 deviceId）。
   * 空字符串 = 使用系统默认麦克风。
   */
  inputDeviceId: string
  /**
   * 麦克风设备列表缓存（最近一次 enumerateDevices 结果）。
   * 用于设置页 UI 展示下拉选项。
   */
  inputDeviceList: AudioDeviceInfo[]
  /** 本地识别：可执行文件路径 */
  localExePath: string
  /** 本地识别：启动参数（模型路径等） */
  localArgs: string
  // ===== v0.5.2 regress-2：TTS（语音合成）独立配置 =====
  /** TTS 引擎模式：disable=关闭 / ai=自定义 AI 接入 */
  ttsMode?: 'disable' | 'ai'
  /** TTS 服务商标识（独立存储，存储 provider UUID） */
  ttsProvider?: string
}

/** 语音配置 CRUD + 触发接口 */
export interface VoiceConfigAPI {
  /** 读取语音配置 */
  getConfig(): Promise<VoiceConfig>
  /** 更新语音配置（合并 patch） */
  setConfig(patch: Partial<VoiceConfig>): Promise<VoiceConfig>
  /** 触发后台语音录音（显示独立预览窗，统一入口） */
  triggerStart(): Promise<void>
  /** 停止后台语音录音并注入发送（隐藏预览窗） */
  triggerStop(): Promise<void>
  /** v0.5.2 regress-2：测试 TTS 配置连通性，返回 { ok, message, audioDataUrl? } */
  testTts(input: { providerId: string }): Promise<TestTtsResult>
}

// ── ElectronAPI 根级语音/STT 成员（就近归类） ──

/** 主→最近聚焦窗口渲染：后台识别文本到达，注入 AI 输入框；enterToSend 控制是否自动发送 */
export type OnVoiceInjectAndSendCallback = (cb: (payload: { text: string; enterToSend: boolean }) => void) => () => void

/** 主→预览窗渲染：更新文本/状态 */
export type OnPreviewUpdateCallback = (
  cb: (payload: { text: string; status: 'recording' | 'transcribing' | 'done' | 'sent' }) => void,
) => () => void

/** 主→预览窗渲染：隐藏 */
export type OnPreviewHideCallback = (cb: () => void) => () => void

/** 主→预览窗渲染：开始录音（getUserMedia） */
export type OnVoiceRecordStartCallback = (cb: () => void) => () => void

/** 主→预览窗渲染：停止录音并回传 PCM */
export type OnVoiceRecordStopCallback = (cb: () => void) => () => void

/** 预览窗渲染→主：回传 Float32 PCM 数据 */
export type SendVoiceRecordDataFn = (data: number[]) => void
