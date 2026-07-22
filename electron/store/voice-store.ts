// electron/store/voice-store.ts — 语音输入配置持久化存储 + IPC 注册
//
// 使用 electron-store 将语音配置持久化到磁盘（voice-config.json）。
// 字段：
//   - enterToSend: boolean  后台语音快速输入后是否自动回车发送（默认 false）
//   - sttMode: 识别引擎模式 builtin/ai/local/download（默认 builtin）
//   - aiProvider/ttsProvider: 自定义 AI 接入（存储 provider UUID）
//   - localExePath/localArgs: 自定义本地识别软件
//   - downloadModel/downloadStatus: 轻量级下载模型
//
// 主窗口与自定义对话窗口共用同一份配置（全局设置）。

import Store from 'electron-store'
import { ipcMain, app } from 'electron'
import { statSync } from 'fs'
import * as path from 'path'
import { IPC_CHANNELS, type AudioDeviceInfo } from '../shared/types.js'
import { getStoreCwd } from './store-paths.js'
import { getWhisperCliBinaryNames } from '../stt/binary-resolver.js'

// 持久化存储实例（写入 voice-config.json）
// 开发环境：写入项目内 .app-data/ 目录，规避 TRAE 沙箱对 AppData\Roaming 的写入限制
// 生产环境：使用默认 userData 路径
export interface VoiceConfig {
  /**
   * 语音识别完成后的上屏方式（已移除候选窗，全部自动上屏以减少操作步骤）：
   * - 'auto'（默认）：识别完成后自动注入/粘贴上屏（前台注入 webview，后台 Ctrl+V 粘贴）
   * - 'manual'：同 'auto'，保留枚举仅为兼容旧配置（不再弹候选窗）
   * - 'clipboard'：仅写入剪贴板 + 系统通知，不模拟按键（用户手动粘贴，适用于不想自动上屏的场景）
   *
   * 兼容旧配置：若老用户配置中无此字段但有 enterToSend 字段，
   * getVoiceConfig() 会按 enterToSend 自动迁移（true→auto, false→manual，二者行为现已一致）。
   */
  confirmMode: 'auto' | 'manual' | 'clipboard'
  /** 前台注入后是否自动回车发送（后台粘贴场景不受此字段影响，粘贴即结束） */
  enterToSend: boolean
  /**
   * 已下载完成的模型 ID 列表（每个模型独立跟踪下载状态）
   * 修复：之前用单一 downloadStatus 字段导致"切换模型时丢失状态、已下载的模型仍提示下载"
   */
  downloadedModels: string[]
  /** 当前选中的模型 ID（用于 UI 展示，不一定已下载） */
  downloadModel: string
  /**
   * 当前选中模型的下载状态（向后兼容老配置）：
   * - 'idle' / 'ready' / 'downloading' / 'failed'
   * 真正的"已下载"判断应看 `downloadedModels` 是否包含 `downloadModel`
   */
  downloadStatus: 'idle' | 'ready' | 'downloading' | 'failed'
  /** 识别引擎模式 */
  sttMode: 'builtin' | 'ai' | 'local' | 'download'
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
  /**
   * whisper-cli 引擎二进制是否已下载（**持久化字段**）。
   * - 下载成功后置 true，存入 voice-config.json
   * - 启动时由 getVoiceConfig() 主动扫描磁盘进行修正（兜底：用户手动删文件/移动路径）
   * - 修复用户报告"每次打开设置页都看到下载按钮 / 点了又马上成功"的问题
   * - 与"下载后离线使用"语义一致：用户**完成过**下载，就不再提示下载
   */
  cliDownloaded: boolean
  // ===== v0.5.2 regress-2：TTS（语音合成）独立配置 =====
  /** TTS 引擎模式：disable=关闭 / ai=自定义 AI 接入 */
  ttsMode?: 'disable' | 'ai'
  /** TTS 服务商标识（独立存储，存储 provider UUID） */
  ttsProvider?: string
}

const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  // 默认：自动上屏（前台注入 + 后台粘贴），无需用户二次确认
  confirmMode: 'auto',
  // 默认：前台注入后不自动回车发送（用户可在设置中开启）
  // 改为 false 避免误触发发送；老用户已存储的 true 保持不变（不强制迁移）
  enterToSend: false,
  // 默认：未下载任何模型
  downloadedModels: [],
  // 默认选中 tiny（体积最小，推荐新手先下这个）
  downloadModel: 'whisper-tiny',
  // 默认：未开始下载
  downloadStatus: 'idle',
  // 默认使用本地内置识别（不再预置 Mimo API 端点，需用户自行配置 AI 接入）
  sttMode: 'builtin',
  aiProvider: '',
  // 默认中文（绝大多数使用场景是中文输入）
  language: 'zh',
  localExePath: '',
  localArgs: '',
  // 默认空 = 系统默认麦克风；用户可在设置中切换
  inputDeviceId: '',
  inputDeviceList: [],
  // 默认 false，下载成功后置 true 并持久化
  cliDownloaded: false,
  // v0.5.2 regress-2：TTS 默认关闭，需用户在设置中显式开启
  ttsMode: 'disable',
  ttsProvider: '',
}

/**
 * 同步扫描 userData/bin/ 目录，查找 whisper-cli 引擎二进制。
 * 返回 true 表示磁盘上已存在可执行文件。
 * 使用同步 API 方便在 getVoiceConfig 同步返回的路径里直接调用。
 *
 * 关键：必须用 ESM import 引入 statSync。
 * 修复用户反馈"每次打开都看到下载按钮"——之前用 `require('fs')` 在 ESM 模块中
 * 会抛 ReferenceError（require 未定义），被外层 try/catch 吞掉，
 * 始终返回 false，导致 cfg.cliDownloaded 被错误地重置为 false 并持久化。
 */
function scanWhisperCliExists(): boolean {
  try {
    const binDir = path.join(app.getPath('userData'), 'bin')
    // 候选名按平台区分，统一从 binary-resolver 获取（跨平台一致）
    const candidates = getWhisperCliBinaryNames()
    for (const name of candidates) {
      const full = path.join(binDir, name)
      try {
        // 同步检查：用 ESM 顶层 import 的 statSync
        // 仅 import 同步 fs，避免在主进程阻塞事件循环
        // （这是配置读取，路径已知且小，开销可忽略）
        const s = statSync(full)
        if (s.isFile() && s.size > 1024) {
          return true
        }
      } catch {
        // 文件不存在或无权限，继续找下一个
      }
    }
    return false
  } catch (err) {
    console.warn('[voice-store] 扫描 whisper-cli 失败:', err)
    return false
  }
}

const store = new Store<{ config: VoiceConfig; version: number }>({
  name: 'voice-config',
  cwd: getStoreCwd(),
  defaults: {
    config: DEFAULT_VOICE_CONFIG,
    version: 2,
  },
})

/** 读取语音配置（自动合并默认值，确保所有字段都存在；自动迁移旧配置） */
export function getVoiceConfig(): VoiceConfig {
  const stored = (store.get('config') || {}) as Partial<VoiceConfig>
  const merged: VoiceConfig = { ...DEFAULT_VOICE_CONFIG, ...stored }
  // 老用户：仅 enterToSend 有值但 confirmMode 未显式设置时，统一迁移到 'auto'
  // （候选窗已移除，manual 与 auto 行为一致，统一用 auto 表示"自动上屏"）
  if (stored.enterToSend !== undefined && (stored as { confirmMode?: string }).confirmMode === undefined) {
    merged.confirmMode = 'auto'
  }
  // 老用户：旧值 'manual' 保留兼容（行为等同 'auto'），不强制改写避免频繁写盘
  // 老用户：仅有 downloadStatus='ready' + downloadModel 但无 downloadedModels 时，
  // 把当前已 ready 的 model 迁移到 downloadedModels 数组（单元素）。
  // 这样首次升级到本版本后，旧的"已下载"模型不会显示下载按钮。
  if (
    Array.isArray(merged.downloadedModels) &&
    merged.downloadedModels.length === 0 &&
    stored.downloadStatus === 'ready' &&
    stored.downloadModel
  ) {
    merged.downloadedModels = [stored.downloadModel]
  }
  // 关键修复：以磁盘为最终标准修正 cfg.cliDownloaded（**只升不降**，与"下载后离线使用"语义一致）。
  // 启动时若磁盘已存在二进制但 cfg.cliDownloaded=false（迁移场景 / cfg 被清理），
  // 主动修正为 true 并持久化。
  // 反之：若磁盘不存在但 cfg=true（用户手动删了文件 / 路径变化），
  // **不**自动降级为 false——一旦用户"完成过"下载，状态就永久保持，
  // 避免因为文件被清理/移动/安全软件误删后再次误显下载按钮。
  // 修复用户报告"每次打开设置页都看到下载按钮 / 点了又马上成功 / 重启后仍提示下载"的问题。
  const onDisk = scanWhisperCliExists()
  if (onDisk && !merged.cliDownloaded) {
    merged.cliDownloaded = true
    // 持久化修正（仅在状态变化时写一次，避免每次 getVoiceConfig 都写盘）
    store.set('config', merged)
  }
  return merged
}

/** 更新语音配置（合并 patch） */
export function updateVoiceConfig(patch: Partial<VoiceConfig>): VoiceConfig {
  const current = store.get('config')
  const next: VoiceConfig = { ...current, ...patch }
  store.set('config', next)
  return next
}

/** 注册语音配置 IPC 处理器 */
export function registerVoiceConfigIPC(): void {
  ipcMain.handle(IPC_CHANNELS.VOICE_GET_CONFIG, () => getVoiceConfig())
  ipcMain.handle(IPC_CHANNELS.VOICE_SET_CONFIG, (_e, patch: Partial<VoiceConfig>) =>
    updateVoiceConfig(patch),
  )
}
