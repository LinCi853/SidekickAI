// electron/voice/background-voice.ts — 后台语音（Alt+V 录音 + 识别 + 上屏）
//
// 从 main.ts 抽离：
//   - startBackgroundVoice / stopBackgroundVoice：Alt+V keydown/keyup 入口
//   - startBuiltinSpeechRecognition：builtin 模式渲染层 Web Speech API 桥接
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

import { app, ipcMain } from 'electron'
import path from 'path'
import { existsSync } from 'fs'
import { IPC_CHANNELS } from '../shared/types.js'
import { getVoiceConfig } from '../store/voice-store.js'
import { WHISPER_CLI_BINARIES } from '../stt/binary-resolver.js'
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
    // 自愈：先强制 stop 旧的录音（如果旧的 sttEngine 还在录音，会被 stop 再次触发）
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
  // 录音最大时长 watchdog：60s 后若仍未收到 keyup，强制停止
  // 解决"热键 keyup 丢失导致录音无限期挂起"的边界情况
  clearRecordingWatchdog()
  recordingWatchdog = setTimeout(() => {
    if (!backgroundRecording) return
    console.warn(`[voice] 录音已达最大时长 ${MAX_RECORDING_DURATION_MS / 1000}s，强制停止`)
    void stopBackgroundVoice(sttEngine)
  }, MAX_RECORDING_DURATION_MS)
  try {
    // 设置预览窗为渲染进程录音目标（getUserMedia 录音，无需 ffmpeg）
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
 * builtin 模式特殊路径：主进程不执行 whisper 识别，而是通过 IPC 通知预览窗（RecordIndicator）
 * 启动 webkitSpeechRecognition（Chromium 渲染层 API），等待渲染层回传识别文本后走同一套上屏流程。
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
  // 正常 stop 时清掉 watchdog
  clearRecordingWatchdog()
  console.log('[voice] 停止录音（松开），开始识别…')
  const earlyError = sttEngine.getLastError?.()
  if (earlyError) {
    console.log('[voice] 检测到早前错误，跳过转写：', earlyError)
  }

  const config = getVoiceConfig()

  // ---- builtin 模式：渲染层 Web Speech API 处理，不走 whisper 路径 ----
  // 主进程仅负责：停止录音（释放麦克风）→ 通知渲染层启动 webkitSpeechRecognition →
  // 等待渲染层回传结果 → 复用统一的 deliverVoiceText 上屏流程。
  if (config.sttMode === 'builtin') {
    try {
      // 1. 停止录音并释放麦克风（builtin 不需要 PCM 数据，但必须释放 getUserMedia 持有的设备，
      //    否则 webkitSpeechRecognition 无法获取麦克风）
      await sttEngine.stopCaptureOnly()
      // 2. 切换预览窗为"识别中"状态
      showPreview({ status: 'transcribing', text: '正在识别…' })
      // 3. 通知预览窗启动 Web Speech API，等待结果回传
      const text = await startBuiltinSpeechRecognition(config.language || 'zh')
      console.log('[voice] builtin 识别结果:', text ? `"${text.slice(0, 50)}"` : '(空)')
      if (text && text.trim()) {
        deliverVoiceText(text, config)
      } else {
        const errMsg = '未识别到内容，请检查麦克风或网络连接（内置识别需联网使用浏览器语音识别服务）'
        console.log('[main] builtin 语音识别失败详情:', errMsg)
        showPreview({ status: 'done', text: errMsg })
        hidePreviewDelayed()
      }
    } catch (err) {
      console.error('[main] builtin 语音识别失败:', err)
      showPreview({
        status: 'done',
        text: '未识别到内容，请检查麦克风或网络连接（内置识别需联网使用浏览器语音识别服务）',
      })
      hidePreviewDelayed()
    }
    return
  }

  // ---- 非 builtin 模式：主进程 whisper / ai / local 识别 ----
  try {
    const text = await sttEngine.stop()
    console.log('[voice] 识别结果:', text ? `"${text.slice(0, 50)}"` : '(空)')
    if (text && text.trim()) {
      deliverVoiceText(text, config)
    } else {
      // 识别返回空：优先使用 engine 记录的精确错误（避免误报"未识别到内容"）。
      // 兜底：引擎无错误但确实没结果时，给出通用提示。
      const lastError = sttEngine.getLastError?.()
      let errMsg = lastError || '未识别到内容'
      // 兜底：download 模式 + 引擎未下载 → 引导用户去下载
      if (!lastError) {
        if (config.sttMode === 'download') {
          const binDir = path.join(app.getPath('userData'), 'bin')
          const names = WHISPER_CLI_BINARIES
          const hasCli = names.some((n) => existsSync(path.join(binDir, n)))
          if (!hasCli) errMsg = 'whisper-cli 引擎未下载，请在设置中下载'
        }
      }
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
 * builtin 模式：通知预览窗启动 webkitSpeechRecognition 并等待识别结果。
 * 通过 IPC_CHANNELS.VOICE_BUILTIN_START 通知渲染层，渲染层识别完成后通过
 * VOICE_BUILTIN_RESULT / VOICE_BUILTIN_ERROR 回传。超时 15s 后失败。
 *
 * 关键：webkitSpeechRecognition 只能在渲染进程（Chromium 浏览器上下文）运行，
 * 主进程无法直接调用。此函数是主→渲染→主的 IPC 桥接。
 *
 * @param language ISO 639-1 语种码（如 'zh' / 'en' / 'auto'），会映射为 BCP-47 标签传给渲染层
 * @returns 识别到的文本（失败/超时返回空串）
 */
function startBuiltinSpeechRecognition(language: string): Promise<string> {
  return new Promise((resolve) => {
    const previewWin = windowState.previewWindow
    if (!previewWin || previewWin.isDestroyed()) {
      console.error('[voice] builtin 识别失败：预览窗不可用')
      resolve('')
      return
    }

    // 语种码映射：ISO 639-1 → BCP-47（webkitSpeechRecognition.lang 接受 BCP-47）
    const langMap: Record<string, string> = {
      zh: 'zh-CN',
      'zh-cn': 'zh-CN',
      en: 'en-US',
      ja: 'ja-JP',
      ko: 'ko-KR',
      fr: 'fr-FR',
      de: 'de-DE',
      es: 'es-ES',
      ru: 'ru-RU',
    }
    const bcp47 = langMap[(language || 'zh').toLowerCase()] || 'zh-CN'

    let settled = false
    let timer: NodeJS.Timeout | null = null

    const cleanup = () => {
      ipcMain.removeListener(IPC_CHANNELS.VOICE_BUILTIN_RESULT, onResult)
      ipcMain.removeListener(IPC_CHANNELS.VOICE_BUILTIN_ERROR, onError)
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
    const finish = (text: string) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(text)
    }
    const onResult = (_e: unknown, text: string) => {
      console.log('[voice] 收到 builtin 识别结果:', text ? `"${text.slice(0, 80)}"` : '(空)')
      finish(text || '')
    }
    const onError = (_e: unknown, errMsg: string) => {
      console.warn('[voice] 收到 builtin 识别错误:', errMsg)
      finish('')
    }

    ipcMain.on(IPC_CHANNELS.VOICE_BUILTIN_RESULT, onResult)
    ipcMain.on(IPC_CHANNELS.VOICE_BUILTIN_ERROR, onError)

    // 超时保护：webkitSpeechRecognition 无响应时避免永久挂起
    timer = setTimeout(() => {
      console.warn('[voice] builtin 识别超时（15s），视为失败')
      finish('')
    }, 15000)

    // 通知预览窗启动 Web Speech API
    try {
      previewWin.webContents.send(IPC_CHANNELS.VOICE_BUILTIN_START, { language: bcp47 })
      console.log('[voice] 已通知预览窗启动 Web Speech API，lang=' + bcp47)
    } catch (err) {
      console.error('[voice] 发送 VOICE_BUILTIN_START 失败:', err)
      finish('')
    }
  })
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
