// electron/voice/background-voice.ts — 后台语音（Alt+V 录音 + 识别 + 上屏）
//
// 从 main.ts 抽离：
//   - startBackgroundVoice / stopBackgroundVoice：Alt+V keydown/keyup 入口
//   - deliverVoiceText：识别文本上屏（前台注入 / 后台粘贴 / 剪贴板）
//   - clearRecordingWatchdog + recordingWatchdog + backgroundRecording：录音状态
//
// 依赖：
//   - sttEngine 由 main.ts 注入（参数传入，避免本模块持有全局单例）
//   - preview-window.ts：showPreview / hidePreviewDelayed / hidePreview / hasAppFocusedWindow
//   - clipboard-paste.ts：pasteTextToExternalApp
//
// registerVoiceIpc / registerHotkeyIpc 接收的 startBackgroundVoice/stopBackgroundVoice
// 是无参函数，main.ts 用箭头包装本模块的 (sttEngine) 签名。

import { IPC_CHANNELS } from '../shared/types.js'
import { getVoiceConfig } from '../store/voice-store.js'
import type { SttEngine } from '../stt/engine.js'
import { windowState } from '../window-state.js'
import { showNotification } from '../notify.js'
import {
  showPreview,
  hidePreviewDelayed,
  hidePreview,
  hasAppFocusedWindow,
} from './preview-window.js'
import { pasteTextToExternalApp } from './clipboard-paste.js'

/** 后台录音状态：true 表示当前正在录音（Alt+V 按下中） */
let backgroundRecording = false
/** 录音最大时长（ms）—— 兜底防止热键 keyup 丢失导致录音无限期挂起 */
const MAX_RECORDING_DURATION_MS = 10_000
/** 录音自动停止定时器 */
let recordingWatchdog: NodeJS.Timeout | null = null

/**
 * 清除录音 watchdog 定时器
 */
function clearRecordingWatchdog(): void {
  if (recordingWatchdog) {
    clearTimeout(recordingWatchdog)
    recordingWatchdog = null
  }
}

/**
 * 启动后台语音录音（Alt+V keydown，主窗口未聚焦时调用）。
 * 显示预览窗"录音中…"，调用 SttEngine.start()。
 *
 * 自愈机制：若上一次录音因 keyup 丢失等原因未正常结束（backgroundRecording 仍为 true），
 * 再次按下 Alt+V 时自动先 stop 旧的录音，再开新的，避免 UI 永远卡在"正在聆听"。
 */
export async function startBackgroundVoice(sttEngine: SttEngine): Promise<void> {
  if (backgroundRecording) {
    console.warn('[voice] 检测到上一次录音未正常结束，强制 stop 后重新开始')
    try {
      await stopBackgroundVoice(sttEngine)
    } catch (err) {
      console.error('[voice] 自愈 stop 失败:', err)
    }
  }
  backgroundRecording = true
  console.log('[voice] 开始录音（按下）')
  showPreview({ status: 'recording', text: '正在聆听…' })
  clearRecordingWatchdog()
  recordingWatchdog = setTimeout(() => {
    if (!backgroundRecording) return
    console.warn(`[voice] 录音已达最大时长 ${MAX_RECORDING_DURATION_MS / 1000}s，强制停止`)
    void stopBackgroundVoice(sttEngine)
  }, MAX_RECORDING_DURATION_MS)
  try {
    if (windowState.previewWindow && !windowState.previewWindow.isDestroyed()) {
      sttEngine.setRendererWindow(windowState.previewWindow)
    }
    await sttEngine.start()
  } catch (err) {
    console.error('[main] 后台语音启动失败:', err)
    backgroundRecording = false
    clearRecordingWatchdog()
    showPreview({ status: 'done', text: '录音启动失败' })
    hidePreviewDelayed()
  }
}

/**
 * 停止后台语音录音并识别（Alt+V keyup）。
 * 识别成功 → 自动上屏，无需用户二次确认（减少操作步骤）：
 *   - 应用前台 (lastFocusedWin 是 mainWindow / chatWindow) → 注入到对应 webview/textarea
 *     enterToSend 控制是否自动回车发送；voice config 的 inputSelector/sendSelector 可覆盖平台默认选择器
 *   - 应用后台 (用户在 Notepad/VSCode/微信) → 剪贴板 + SendInput Ctrl+V（粘贴前备份原剪贴板，粘贴后恢复）
 *   - confirmMode='clipboard' → 仅写入剪贴板 + 通知，不模拟按键（用户手动粘贴）
 *
 * 关键：上屏路径在识别完成的当下动态判断 hasAppFocusedWindow()，避免缓存焦点状态导致的误分发。
 * 识别失败 → 预览窗显示错误提示。
 */
export async function stopBackgroundVoice(sttEngine: SttEngine): Promise<void> {
  if (!backgroundRecording) {
    console.warn('[voice] stopBackgroundVoice 被调用但 backgroundRecording=false，跳过（可能 watchdog 已触发）')
    return
  }
  backgroundRecording = false
  clearRecordingWatchdog()
  console.log('[voice] 停止录音（松开），开始识别…')
  const earlyError = sttEngine.getLastError?.()
  if (earlyError) {
    console.log('[voice] 检测到早前错误，跳过转写：', earlyError)
  }

  const config = getVoiceConfig()

  try {
    const text = await sttEngine.stop()
    console.log('[voice] 识别结果:', text ? `"${text.slice(0, 50)}"` : '(空)')
    if (text && text.trim()) {
      deliverVoiceText(text, config)
    } else {
      const lastError = sttEngine.getLastError?.()
      const errMsg = lastError || '未识别到内容'
      console.log('[main] 语音识别失败详情:', errMsg)
      showPreview({ status: 'done', text: errMsg })
      hidePreviewDelayed()
    }
  } catch (err) {
    console.error('[main] 后台语音识别失败:', err)
    showPreview({ status: 'done', text: '识别失败：' + (err instanceof Error ? err.message : String(err)) })
    hidePreviewDelayed()
  }
}

/**
 * 把识别文本上屏（前台注入 / 后台粘贴 / 剪贴板）。
 * builtin 与非 builtin 模式共用此路径，确保上屏行为一致。
 */
function deliverVoiceText(text: string, config: ReturnType<typeof getVoiceConfig>): void {
  if (!text || !text.trim()) return
  // 识别成功后立即隐藏录音指示器，避免与自动上屏动作同时出现
  hidePreview()
  // 动态判断应用前台状态（场景14：上屏时刻重新检查焦点，不使用缓存值）
  const appIsFocused = hasAppFocusedWindow()
  console.log(`[voice] 自动上屏：appIsFocused=${appIsFocused}，confirmMode=${config.confirmMode}`)
  if (config.confirmMode === 'clipboard') {
    // 仅写入剪贴板 + 通知，不模拟按键（用户手动粘贴）
    try {
      const { clipboard } = require('electron') as typeof import('electron')
      clipboard.writeText(text)
      showNotification('语音已识别', '文本已写入剪贴板，请手动粘贴')
    } catch (e) {
      console.error('[voice] 写入剪贴板失败:', e)
      showPreview({ status: 'done', text: '写入剪贴板失败' })
      hidePreviewDelayed()
    }
    return
  }
  if (appIsFocused) {
    // 前台场景：注入到目标 webview 输入框
    let target = windowState.lastFocusedWin
    if (!target || target.isDestroyed() || !target.isVisible()) {
      target = windowState.mainWindow
    }
    // 选择器由渲染层从 Profile（aiInputSelector/aiSendSelector）+ 平台预设读取，主进程不再传递
    const payload = {
      text,
      enterToSend: config.enterToSend,
    }
    try {
      target?.webContents.send(IPC_CHANNELS.VOICE_INJECT_AND_SEND, payload)
      console.log('[voice] 前台模式：已发送 VOICE_INJECT_AND_SEND')
    } catch (err) {
      console.error('[voice] VOICE_INJECT_AND_SEND 失败:', err)
    }
  } else {
    // 后台场景：剪贴板 + SendInput Ctrl+V（含原剪贴板备份/恢复，场景15）
    pasteTextToExternalApp(text)
    console.log('[voice] 后台模式：已触发粘贴上屏')
  }
}
