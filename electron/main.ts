// electron/main.ts — Electron 主进程入口
//
// AI 窗口主进程：负责窗口管理、Profile 存储、指纹引擎、热键、语音识别。
// 多标签 + 脱离窗口架构：
//   - 主窗口（windowId='main'）：多标签，顶栏 + 底栏
//   - 脱离窗口（windowId=UUID）：单标签，顶栏
//   - 所有窗口状态持久化到 window-states.json
//   - Alt+Q 切换所有脱离窗口显隐（自定义窗口快捷键）
//
// 窗口创建函数已抽离到 electron/window-factory.ts，全局可变窗口状态集中托管在
// electron/window-state.ts（windowState）。本文件保留：生命周期管理、IPC 注册、
// 后台语音（预览窗 + STT）、便携模式检测。

import { app, BrowserWindow, Menu, Tray, nativeImage, screen, session, ipcMain, protocol, systemPreferences } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync, existsSync } from 'fs'
import {
  registerProfileIPC,
  ensureDefaultProfiles,
  migrateAIPlatformIds,
} from './store/profile-store.js'
import {
  registerPromptIPC,
  ensureDefaultPrompts,
} from './store/prompt-store.js'
import {
  registerBlockRulesIPC,
  ensureDefaultBlockRules,
} from './store/block-rules-store.js'
import {
  registerPresetsIPC,
  ensureDefaultPresets,
} from './store/preset-store.js'
import { registerAIProviderIPC, ensureDefaultProviders } from './store/ai-provider-store.js'
import { registerNotesIPC } from './store/notes-db.js'
import { registerWhiteboardIPC, getWhiteboardDb } from './store/whiteboard-db.js'
import { registerWhiteboardAssetIPC } from './store/whiteboard-asset-store.js'
import { migrateWhiteboardNotes } from './store/migrate-whiteboard-notes.js'
import { promptStore } from './store/prompt-store.js'
import { registerVoiceConfigIPC, getVoiceConfig } from './store/voice-store.js'
import { registerAppSettingsIPC, getAppSettings, updateAppSettings, applyAutoLaunchSetting } from './store/app-settings-store.js'
import { registerProxyAuthHandler } from './store/proxy-helper.js'
import { initChatStore, closeChatStore, getChatStore } from './store/chat-store.js'
import { registerAIChatIPC, cleanupActiveStreams } from './ai/handler.js'
import { WindowManager } from './window/manager.js'
import { FingerprintEngine } from './fingerprint/engine.js'
import { HotkeyManager } from './hotkey/manager.js'
import { SttEngine } from './stt/engine.js'
import { WHISPER_CLI_BINARIES } from './stt/binary-resolver.js'
import { IPC_CHANNELS } from './shared/types.js'
import type { WhiteboardCard, WhiteboardCardInput } from './shared/whiteboard.types.js'
import { registerWindowControlIpc } from './ipc/window-control-ipc.js'
import { registerTabIpc } from './ipc/tab-ipc.js'
import { registerHotkeyIpc } from './ipc/hotkey-ipc.js'
import { registerVoiceIpc } from './ipc/voice-ipc.js'
import { registerPromptIpc } from './ipc/prompt-ipc.js'
import { registerSettingsIpc } from './ipc/settings-ipc.js'
import { showNotification } from './notify.js'
import { simulatePaste, ERR_MAC_ACCESSIBILITY_DENIED } from './utils/platform-actions.js'
import { promptAccessibilityPermission } from './utils/permission-manager.js'
import { registerPlatformInfoIPC } from './utils/platform-info.js'
import { attachDownloadHandlersForAllProfiles, maybeAutoCleanCache } from './utils/download-handler.js'
import { windowState } from './window-state.js'
import {
  createMainWindow,
  createStandaloneWindow,
  createChatWindow,
  showHistoryWindow,
  showPromptWindow,
  showAiAppEditorWindow,
  openAiAppProviderWindow,
  toggleAiAppProviderWindow,
  showOnboardingWindow,
  setOnboardingLifecycleCallbacks,
  showProcessCleanupWindow,
  getSenderWindow,
  findWindowIdByWin,
  loadRenderer,
} from './window-factory.js'
import { isPortableMode } from './store/store-paths.js'
import { detectResidualProcesses, killProcesses } from './utils/process-guard.js'

/** 主窗口默认宽度（窗口复位时使用） */
const DEFAULT_MAIN_WINDOW_WIDTH = 420
/** 主窗口默认高度（窗口复位时使用） */
const DEFAULT_MAIN_WINDOW_HEIGHT = 820
/** 后台语音预览窗自动隐藏延迟（毫秒） */
const PREVIEW_HIDE_DELAY_MS = 3000

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 开发模式判断：使用 app.isPackaged 确保打包后判断准确
const isDev = !app.isPackaged
const getPreloadPath = (): string => {
  if (isDev) {
    return path.resolve(__dirname, '../preload/index.mjs')
  }
  return path.join(__dirname, '../preload/index.mjs')
}

// 全局错误捕获
process.on('unhandledRejection', (reason) => {
  console.error('[main] Unhandled Rejection:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[main] Uncaught Exception:', err)
})

app.commandLine.appendSwitch('disable-crashpad')
// AMD 显卡兼容：禁用 GPU 沙箱，避免 GPU process 因非法指令崩溃（exit_code=-1073741795）
app.commandLine.appendSwitch('disable-gpu-sandbox')
// Linux 多屏 DPI 缩放兜底：force-device-scale-factor=1 防止跨屏拖动后 webContents
// 缩放错乱。优先方案是 display-metrics-changed 监听（见 app.whenReady）动态重设
// zoomFactor，此 switch 仅作为无法动态修正时的兜底。
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
}

// ===== 单实例锁：避免重复启动开多个主窗口 =====
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  // 第二实例：直接退出，由 first-instance 处理唤醒
  console.log('[main] 检测到已有实例运行，第二实例退出')
  app.quit()
}
// second-instance 处理在 whenReady 后注册（需要 mainWindow 引用）

// 便携模式检测：
// - 开发环境：userData 重定向到项目内 .app-data/
// - 生产便携版：在 exe 同级目录放置 portable.txt 标记文件，
//   userData 重定向到 exe 同级 data/ 目录（绿色版，数据跟随 exe）
// - 生产安装版：使用系统默认 %APPDATA%/ai-window
function redirectUserData(): void {
  // 开发模式
  if (process.env.ELECTRON_RENDERER_URL) {
    const userDataPath = path.join(__dirname, '..', '..', '.app-data')
    try {
      mkdirSync(userDataPath, { recursive: true })
      app.setPath('userData', userDataPath)
      console.log('[main] Dev mode: userData redirected to', app.getPath('userData'))
    } catch (err) {
      console.error('[main] Failed to set userData path:', err)
    }
    return
  }

  // 生产便携模式：检测 exe 同级 portable.txt
  try {
    const exePath = app.getPath('exe')
    const exeDir = path.dirname(exePath)
    const portableMarker = path.join(exeDir, 'portable.txt')
    if (existsSync(portableMarker)) {
      const userDataPath = path.join(exeDir, 'data')
      mkdirSync(userDataPath, { recursive: true })
      app.setPath('userData', userDataPath)
      console.log('[main] Portable mode: userData redirected to', app.getPath('userData'))
    }
  } catch (err) {
    console.error('[main] Portable mode detection failed:', err)
  }
}
redirectUserData()

// 注册白板图片自定义协议为特权协议（必须在 app ready 前调用）
// 解决 dev 模式下 file:// 被 webSecurity CORS 阻止的问题
protocol.registerSchemesAsPrivileged([
  { scheme: 'whiteboard-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
])

// 全局管理器实例（fingerprintEngine/hotkeyManager/sttEngine 仅本文件使用；
// windowManager 已迁入 windowState，因 window-factory.ts 的窗口创建函数需读取）
let fingerprintEngine: FingerprintEngine
let hotkeyManager: HotkeyManager
let sttEngine: SttEngine
// 系统托盘
let tray: Tray | null = null
// 后台语音录音指示器的隐藏定时器与录音状态（仅后台语音流程使用，保留本文件）
let previewHideTimer: NodeJS.Timeout | null = null
let backgroundRecording = false
/** 录音最大时长（ms）—— 兜底防止热键 keyup 丢失导致录音无限期挂起 */
const MAX_RECORDING_DURATION_MS = 10_000
/** 录音自动停止定时器 */
let recordingWatchdog: NodeJS.Timeout | null = null
/** 剪贴板恢复定时器（后台粘贴后延迟恢复用户原剪贴板内容） */
let clipboardRestoreTimer: NodeJS.Timeout | null = null
/**
 * 待投递的白板推送卡片队列（跨窗口推送：请求窗口 → 主进程 → 白板渲染窗口）。
 * 渲染层 ready 后回 ACK（ipcRenderer.send），主进程 flush 队列一次性投递全部待推送卡片。
 * 替代旧的 ipcMain.once/ipcMain.handle 互不触发的缺陷方案。
 */
const pendingWhiteboardPushes: Array<{ whiteboardId: string; card: WhiteboardCard; win: BrowserWindow }> = []

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
 * 创建系统托盘
 * 功能：显示主窗口、窗口复位（大小位置）、退出应用
 */
function createTray(): void {
  if (tray) return
  try {
    const resourcesPath = path.join(__dirname, '..', '..', 'resources', 'icons')
    const isMac = process.platform === 'darwin'
    // macOS 使用 template image（单色，自动适配深色/浅色模式）；
    // Windows/Linux 使用彩色 icon.png（16x16）
    const iconPath = isMac
      ? path.join(resourcesPath, 'icon-tray-template.png')
      : path.join(resourcesPath, 'icon.png')
    let trayIcon = nativeImage.createFromPath(iconPath)
    // macOS template image 缺失时回退到 icon.png，避免托盘创建失败
    if (isMac && trayIcon.isEmpty()) {
      console.warn('[main] macOS template 托盘图标缺失，回退 icon.png')
      trayIcon = nativeImage.createFromPath(path.join(resourcesPath, 'icon.png'))
    }
    if (trayIcon.isEmpty()) {
      console.warn('[main] 托盘图标不存在，跳过创建托盘')
      return
    }
    if (isMac) {
      // template image 自动适配深色/浅色模式；macOS 托盘规范 22x22
      trayIcon.setTemplateImage(true)
      trayIcon = trayIcon.resize({ width: 22, height: 22 })
    } else {
      trayIcon = trayIcon.resize({ width: 16, height: 16 })
    }
    tray = new Tray(trayIcon)
    tray.setToolTip('工百窗')
    windowState.trayEnabled = true

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => {
          const win = windowState.mainWindow
          if (!win || win.isDestroyed()) {
            createMainWindow()
            return
          }
          if (win.isMinimized()) win.restore()
          if (!win.isVisible()) win.show()
          win.focus()
          win.webContents.send(IPC_CHANNELS.WINDOW_SHOWN)
        },
      },
      {
        label: '窗口复位（恢复默认大小位置）',
        click: () => {
          const win = windowState.mainWindow
          if (!win || win.isDestroyed()) return
          const workArea = screen.getPrimaryDisplay().workArea
          const defaultWidth = 420
          const defaultHeight = 820
          const x = Math.round(workArea.x + workArea.width - defaultWidth - 20)
          const y = Math.round(workArea.y + 20)
          if (win.isMaximized()) win.unmaximize()
          if (win.isMinimized()) win.restore()
          if (!win.isVisible()) win.show()
          win.setBounds({ x, y, width: defaultWidth, height: defaultHeight })
          win.focus()
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          app.quit()
        },
      },
    ])

    tray.setContextMenu(contextMenu)

    // 单击显示/隐藏主窗口
    tray.on('click', () => {
      const win = windowState.mainWindow
      if (!win || win.isDestroyed()) {
        createMainWindow()
        return
      }
      if (win.isVisible()) {
        win.hide()
      } else {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
        win.webContents.send(IPC_CHANNELS.WINDOW_SHOWN)
      }
    })

    console.log('[main] 系统托盘已创建')
  } catch (err) {
    console.error('[main] 创建托盘失败:', err)
  }
}

/**
 * 创建后台语音录音指示器（frameless 长条形透明窗，alwaysOnTop，skipTaskbar）。
 * 长条形窗口显示：录音状态图标 + 实时音量波形 + 状态文字/识别结果。
 * ?windowId=preview&mode=record-indicator → RecordIndicator 路由。
 * 首次创建后复用（hide/show），不重复创建。
 */
function createRecordIndicatorWindow(): BrowserWindow {
  // 长条形窗口：宽 360px，高 56px，圆角胶囊形
  // 放开大小限制，允许 resize（但默认尺寸固定）
  //
  // 平台差异：
  //   - macOS：transparent:true 需配合 visualEffectState:'active' 维持激活态毛玻璃
  //   - Linux：transparent 在 Wayland 下黑屏，关闭并用深色背景模拟胶囊
  //   - Windows：保持原透明胶囊行为
  const isMac = process.platform === 'darwin'
  const isLinux = process.platform === 'linux'
  const win = new BrowserWindow({
    width: 360,
    height: 56,
    minWidth: 240,
    minHeight: 48,
    maxWidth: 720,
    maxHeight: 120,
    show: false,
    frame: false,
    resizable: true,
    minimizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: isLinux ? '#1e1e1e' : 'rgba(0, 0, 0, 0)',
    hasShadow: false,
    // Linux 关闭透明避免黑屏；macOS/Windows 保持透明胶囊
    transparent: !isLinux,
    // Windows 专属字段
    ...(process.platform === 'win32'
      ? { backgroundMaterial: 'none' as const, thickFrame: false }
      : {}),
    // macOS 透明窗口需激活态毛玻璃，否则可能显示异常
    ...(isMac ? { visualEffectState: 'active' as const } : {}),
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      backgroundThrottling: false,
    },
  })

  loadRenderer(win, 'preview', 'record-indicator')

  win.on('closed', () => {
    if (windowState.previewWindow === win) windowState.previewWindow = null
  })

  return win
}

/** 最新预览状态（用于 dom-ready 后补发，防止首次创建时消息丢失） */
/** 简化后：只显示一个非常小的录音指示器（无文字、无中间状态、无结果展示） */
let latestPreviewState: {
  status: 'recording' | 'transcribing' | 'done' | 'sent'
  text: string
} = { status: 'recording', text: '' }

/**
 * 应用前台状态：true 表示至少有一个 BrowserWindow 当前处于 focus
 * 用于决定语音识别后是注入到应用内 webview 还是写入剪贴板
 */
let appHasFocusedWindow = false

/**
 * 初始化前台状态追踪。
 * 在 app.whenReady() 后调用一次即可。
 */
function initAppFocusTracker(): void {
  // 初始状态：检查当前是否有窗口已 focus
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w.isFocused()) {
      appHasFocusedWindow = true
      break
    }
  }
  // 监听所有窗口的 focus/blur 事件
  app.on('browser-window-focus', () => {
    appHasFocusedWindow = true
  })
  app.on('browser-window-blur', () => {
    // 延迟一帧查询：可能是用户切到本应用的其他窗口，需要重新检查
    setImmediate(() => {
      let anyFocused = false
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed() && w.isFocused()) {
          anyFocused = true
          break
        }
      }
      appHasFocusedWindow = anyFocused
    })
  })
}

/** 判断应用当前是否处于前台（有 BrowserWindow 处于 focus） */
function hasAppFocusedWindow(): boolean {
  return appHasFocusedWindow
}

/**
 * 显示预览窗并更新内容。
 * 若窗口不存在则创建；存在则复用。
 * 首次创建时等待 dom-ready 后再发送状态，避免消息丢失。
 */
function showPreview(payload: {
  status: 'recording' | 'transcribing' | 'done' | 'sent'
  text: string
}): void {
  latestPreviewState = payload
  let isNew = false
  if (!windowState.previewWindow || windowState.previewWindow.isDestroyed()) {
    windowState.previewWindow = createRecordIndicatorWindow()
    isNew = true
  }
  // 取消待隐藏定时器
  if (previewHideTimer) {
    clearTimeout(previewHideTimer)
    previewHideTimer = null
  }
  const win = windowState.previewWindow

  const sendUpdate = () => {
    try {
      win.webContents.send(IPC_CHANNELS.PREVIEW_UPDATE, latestPreviewState)
    } catch (err) {
      console.error('[main] PREVIEW_UPDATE 发送失败:', err)
    }
  }

  if (isNew) {
    // 新创建窗口：等 dom-ready 后再发，确保渲染层监听器已注册
    // 关键：必须先注册监听器再检查 isLoading()，否则 dom-ready 可能已经触发过
    const onReady = () => {
      if (win.isDestroyed()) return
      positionPreviewAtBottomCenter(win)
      sendUpdate()
      if (!win.isVisible()) {
        win.show()
      }
    }
    if (!win.webContents.isLoading()) {
      // dom-ready 已触发过：直接发（监听器会丢失事件）
      onReady()
    } else {
      win.webContents.once('dom-ready', onReady)
    }
  } else {
    positionPreviewAtBottomCenter(win)
    sendUpdate()
    if (!win.isVisible()) {
      win.show()
    }
  }
}

/**
 * 把预览窗定位到主显示器底部居中（长条形胶囊窗口，悬浮在屏幕底部）
 * 距屏幕底部 80px，避免遮挡任务栏
 * 使用窗口当前实际尺寸（用户可 resize），仅居中 x 轴
 */
function positionPreviewAtBottomCenter(win: BrowserWindow): void {
  try {
    const display = screen.getPrimaryDisplay()
    const { width: sw, height: sh } = display.workAreaSize
    const { x: sx, y: sy } = display.workArea
    const [winW, winH] = win.getSize()
    const x = sx + Math.round((sw - winW) / 2)
    const y = sy + sh - winH - 80
    win.setBounds({ x, y, width: winW, height: winH })
  } catch (e) {
    console.warn('[main] 定位预览窗失败:', e)
  }
}

/** 3 秒后隐藏预览窗（不销毁，复用） */
function hidePreviewDelayed(): void {
  if (previewHideTimer) clearTimeout(previewHideTimer)
  previewHideTimer = setTimeout(() => {
    if (windowState.previewWindow && !windowState.previewWindow.isDestroyed() && windowState.previewWindow.isVisible()) {
      try {
        windowState.previewWindow.webContents.send(IPC_CHANNELS.PREVIEW_HIDE)
      } catch (err) {
        console.error('[main] PREVIEW_HIDE 发送失败:', err)
      }
      windowState.previewWindow.hide()
    }
    previewHideTimer = null
  }, PREVIEW_HIDE_DELAY_MS)
}

/**
 * 立即隐藏预览窗（录音指示器），不等待延迟。
 * 识别成功后调用，避免指示器与自动上屏动作同时出现。
 */
function hidePreview(): void {
  if (previewHideTimer) {
    clearTimeout(previewHideTimer)
    previewHideTimer = null
  }
  if (windowState.previewWindow && !windowState.previewWindow.isDestroyed() && windowState.previewWindow.isVisible()) {
    try {
      windowState.previewWindow.webContents.send(IPC_CHANNELS.PREVIEW_HIDE)
    } catch (err) {
      console.error('[main] PREVIEW_HIDE 发送失败:', err)
    }
    windowState.previewWindow.hide()
  }
}

/**
 * 模拟 Ctrl+V / Cmd+V 粘贴到当前前台外部应用。
 * 跨平台实现委托给 platform-actions.simulatePaste：
 *   - Windows: PowerShell SendKeys（原实现）
 *   - macOS:   osascript System Events（需辅助功能权限）
 *   - Linux:   xdotool / wtype / xclip 降级链
 *
 * 保持 fire-and-forget 语义（与原 exec 回调一致）。失败时通知用户手动粘贴；
 * macOS 权限缺失已由 simulatePaste 内部弹 dialog 提示，此处跳过重复通知。
 *
 * 注意：调用方必须确保本应用窗口已失焦（前台为外部应用），且在调用前已隐藏录音指示器，
 * 否则粘贴键会被自身窗口截获。
 */
function simulateCtrlV(): void {
  simulatePaste().catch((err: unknown) => {
    console.error('[voice] 模拟粘贴失败:', err)
    if ((err as Error & { code?: string }).code === ERR_MAC_ACCESSIBILITY_DENIED) {
      // macOS 权限缺失：simulatePaste 已弹 dialog 引导授权，不再重复通知
      return
    }
    showNotification('语音已识别', '请在目标窗口按 Ctrl+V 粘贴')
  })
}

/**
 * 剪贴板内容快照（用于后台粘贴后恢复用户原内容，避免永久覆盖）。
 * 仅备份常见格式：纯文本、HTML、RTF、图片。读取失败的字段留空/标记为不存在。
 */
interface ClipboardSnapshot {
  text: string
  html: string
  rtf: string
  hasImage: boolean
  image: Electron.NativeImage | null
}

/**
 * 备份当前系统剪贴板的常见格式内容。
 * 任何格式读取异常都不影响其他格式的备份。
 */
function backupClipboard(): ClipboardSnapshot {
  const { clipboard } = require('electron') as typeof import('electron')
  const snapshot: ClipboardSnapshot = { text: '', html: '', rtf: '', hasImage: false, image: null }
  try {
    snapshot.text = clipboard.readText() || ''
  } catch (e) {
    console.warn('[voice] 备份剪贴板文本失败:', e)
  }
  try {
    snapshot.html = clipboard.readHTML() || ''
  } catch (e) {
    console.warn('[voice] 备份剪贴板 HTML 失败:', e)
  }
  try {
    snapshot.rtf = clipboard.readRTF() || ''
  } catch (e) {
    console.warn('[voice] 备份剪贴板 RTF 失败:', e)
  }
  try {
    const img = clipboard.readImage()
    snapshot.hasImage = !img.isEmpty()
    snapshot.image = snapshot.hasImage ? img : null
  } catch (e) {
    console.warn('[voice] 备份剪贴板图片失败:', e)
  }
  return snapshot
}

/**
 * 恢复之前备份的剪贴板内容。
 * 按原格式顺序写回；任何格式写回失败仅记录日志，不影响后续格式。
 * 注意：恢复时先把 text 写回，再覆盖 html/rtf/image，确保格式与备份前一致。
 */
function restoreClipboard(snapshot: ClipboardSnapshot): void {
  const { clipboard } = require('electron') as typeof import('electron')
  try {
    clipboard.writeText(snapshot.text)
  } catch (e) {
    console.error('[voice] 恢复剪贴板文本失败:', e)
  }
  if (snapshot.html) {
    try {
      clipboard.writeHTML(snapshot.html)
    } catch (e) {
      console.error('[voice] 恢复剪贴板 HTML 失败:', e)
    }
  }
  if (snapshot.rtf) {
    try {
      clipboard.writeRTF(snapshot.rtf)
    } catch (e) {
      console.error('[voice] 恢复剪贴板 RTF 失败:', e)
    }
  }
  if (snapshot.hasImage && snapshot.image) {
    try {
      clipboard.writeImage(snapshot.image)
    } catch (e) {
      console.error('[voice] 恢复剪贴板图片失败:', e)
    }
  }
}

/**
 * 后台粘贴上屏：把识别文本粘贴到当前前台外部应用。
 * 流程（标准语音输入法行为 + 剪贴板保护）：
 *   1. 备份用户当前剪贴板内容（文本/HTML/RTF/图片）
 *   2. 写入识别文本到剪贴板
 *   3. 延迟 150ms 后模拟 Ctrl+V（等待本应用窗口完全失焦，避免被自身截获）
 *   4. 再延迟 500ms 后静默恢复原剪贴板内容
 * 若恢复失败，至少保留日志，避免用户原内容永久丢失。
 */
function pasteTextToExternalApp(text: string): void {
  const { clipboard } = require('electron') as typeof import('electron')
  // 1. 备份原剪贴板内容
  const snapshot = backupClipboard()
  console.log('[voice] 后台模式：已备份剪贴板原内容，准备写入识别文本')
  // 2. 写入识别文本
  try {
    clipboard.writeText(text)
  } catch (e) {
    console.error('[voice] 写入剪贴板失败:', e)
    return
  }
  // 取消任何挂起的恢复定时器
  if (clipboardRestoreTimer) {
    clearTimeout(clipboardRestoreTimer)
    clipboardRestoreTimer = null
  }
  // 3. 延迟 150ms 模拟 Ctrl+V（等待窗口失焦）
  setTimeout(() => {
    simulateCtrlV()
    // 4. 再延迟 500ms 恢复原剪贴板内容（确保外部应用已读取剪贴板完成粘贴）
    clipboardRestoreTimer = setTimeout(() => {
      clipboardRestoreTimer = null
      try {
        restoreClipboard(snapshot)
        console.log('[voice] 剪贴板原内容已恢复')
      } catch (e) {
        console.error('[voice] 剪贴板恢复失败，原内容可能已被覆盖:', e)
      }
    }, 500)
  }, 150)
}

/**
 * 启动后台语音录音（Alt+V keydown，主窗口未聚焦时调用）。
 * 显示预览窗"录音中…"，调用 SttEngine.start()。
 *
 * 自愈机制：若上一次录音因 keyup 丢失等原因未正常结束（backgroundRecording 仍为 true），
 * 再次按下 Alt+V 时自动先 stop 旧的录音，再开新的，避免 UI 永远卡在"正在聆听"。
 */
async function startBackgroundVoice(): Promise<void> {
  if (backgroundRecording) {
    // 自愈：先强制 stop 旧的录音（如果旧的 sttEngine 还在录音，会被 stop 再次触发）
    console.warn('[voice] 检测到上一次录音未正常结束，强制 stop 后重新开始')
    try {
      await stopBackgroundVoice()
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
    void stopBackgroundVoice()
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
async function stopBackgroundVoice(): Promise<void> {
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

/**
 * 应用就绪：初始化所有管理器并注册 IPC
 */
app.whenReady().then(async () => {
  // 移除默认应用菜单：释放 F11（默认 toggleFullscreen）与 F12（默认 toggleDevTools）
  // 等系统级快捷键，交由应用内 keydown / before-input-event 统一处理。
  // DevTools 可通过 --dev-tools 启动参数或 DEV_TOOLS=1 环境变量打开（见下方 autoOpenDevTools）。
  Menu.setApplicationMenu(null)

  // --dev-tools 启动参数：启动后自动为所有新窗口打开 DevTools（调试模式）
  const autoOpenDevTools = process.argv.includes('--dev-tools') || process.env.DEV_TOOLS === '1'
  if (autoOpenDevTools) {
    console.log('[main] DevTools 调试模式：新窗口将自动打开 DevTools')
    windowState.autoOpenDevTools = true
  }

  // --hidden 启动参数：由开机自启动注入，启动后隐藏到托盘不显示主窗口
  const silentStartRequested = process.argv.includes('--hidden')

  // 初始化应用前台状态追踪（用于语音识别后注入 vs 剪贴板判断）
  initAppFocusTracker()

  // 授权所有窗口 getUserMedia 录音权限（渲染进程音频采集替代 ffmpeg）
  // 双重保险：permissionRequestHandler + devicePermissionHandler
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media') {
      if (process.platform === 'darwin') {
        // macOS：检查系统麦克风权限状态
        // 首次请求会触发系统弹窗，用户授权后 callback(true)
        try {
          const status = systemPreferences.getMediaAccessStatus('microphone')
          callback(status === 'granted')
        } catch {
          // getMediaAccessStatus 在某些 macOS 版本可能不可用，默认允许
          callback(true)
        }
      } else {
        callback(true)
      }
    } else {
      callback(false)
    }
  })
  session.defaultSession.setDevicePermissionHandler((_details) => true)

  fingerprintEngine = new FingerprintEngine()
  const windowManager = new WindowManager(fingerprintEngine)
  windowState.windowManager = windowManager
  hotkeyManager = new HotkeyManager()
  sttEngine = new SttEngine()

  // 使用指南窗口打开时暂停所有全局热键，关闭时恢复
  // 防止 Alt+Space 等快捷键在使用指南中干扰用户操作和热键录制
  setOnboardingLifecycleCallbacks({
    onShow: () => hotkeyManager.pauseAllShortcuts(),
    onClose: () => hotkeyManager.resumeAllShortcuts(),
  })

  // macOS 辅助功能权限检测：uiohook 低级键盘钩子需要此权限
  // 首次运行时提示用户授权（传 true 弹出系统对话框）
  if (process.platform === 'darwin') {
    promptAccessibilityPermission().then((granted) => {
      if (!granted) {
        console.warn('[main] macOS 辅助功能权限未授权，uiohook 将不可用，降级为仅 globalShortcut')
      }
    })
  }

  // 初始化 SQLite 对话持久化存储（必须在 app.whenReady 后调用）
  // 容错：若原生模块加载失败或数据库损坏，不阻塞应用启动，
  // 仅 chat 相关功能不可用（浏览/标签/Profile 等仍正常）
  try {
    initChatStore()
    // 使用统计：记录启动时间戳（受 usageTrackingEnabled 守卫）
    try {
      if (getAppSettings().usageTrackingEnabled) {
        getChatStore().logAppStart()
      }
    } catch (e) {
      console.warn('[main] logAppStart 失败:', e)
    }
  } catch (err) {
    console.error('[main] initChatStore 失败，对话持久化功能将不可用:', err)
  }

  // 首次启动创建默认 AI 平台 Profile，并迁移旧数据补齐 aiPlatformId
  ensureDefaultProfiles()
  migrateAIPlatformIds()

  // 首次启动填充预置提示词模板
  ensureDefaultPrompts()

  // 注册页面组件屏蔽规则 IPC + 首次启动填充预置规则
  registerBlockRulesIPC()
  ensureDefaultBlockRules()
  // 打开 AI 应用编辑独立窗口（编辑模式按 profileId 单例，新建模式固定 'create' 单例）
  ipcMain.handle(IPC_CHANNELS.AI_APP_EDITOR_OPEN, (_e, opts: {
    platformId?: string;
    profileId?: string;
    mode?: 'edit' | 'create';
  }) => {
    if (!opts || typeof opts !== 'object') return
    showAiAppEditorWindow(opts)
  })
  // 打开 AI 应用独立窗口（单例，承载内置 AI/自定义供应商/自定义对话）
  // 可选 providerId：若提供则切换到对应供应商的对话页
  ipcMain.handle(IPC_CHANNELS.AI_APP_PROVIDER_OPEN, (_e, providerId?: string) => {
    openAiAppProviderWindow(providerId ? { providerId, initialTab: 'chat' } : undefined)
  })
  // 切换 AI 应用独立窗口显隐（单例，Alt+Q 入口）
  // v0.5.2：Alt+Q 始终打开 AI 应用窗口，笔记/白板作为该窗口的视图模式
  ipcMain.handle(IPC_CHANNELS.AI_APP_PROVIDER_TOGGLE, () => {
    toggleAiAppProviderWindow()
  })

  // 需求 11：笔记 → 当前 AI 输入框
  // v0.5.2：笔记嵌入 StandaloneView，sender 即 AI 应用窗口。
  // 查找最近聚焦窗口（lastFocusedWin），把笔记文本直接注入其激活的 AI 输入框。
  // 复用与语音注入相同的 VOICE_INJECT_AND_SEND 通道：渲染层 MainView/ChatView/AiProviderAppView
  // 均已实现该监听器，自动适配 webview 输入框 / textarea / 自定义对话输入框。
  // 注入结果通过 NOTES_INJECT_RESULT 回传到调用方窗口（sender），供其显示 toast。
  ipcMain.handle(
    IPC_CHANNELS.NOTES_SEND_TO_AI,
    async (e, payload: { text: string; enterToSend?: boolean }) => {
      const text = payload?.text ?? ''
      if (!text.trim()) {
        return { ok: false, error: '笔记内容为空' }
      }
      // 选择目标窗口：优先 lastFocusedWin（排除 sender 自己），回退到 mainWindow
      const senderWin = BrowserWindow.fromWebContents(e.sender)
      let target = windowState.lastFocusedWin
      if (!target || target.isDestroyed() || !target.isVisible() || target === senderWin) {
        target = windowState.mainWindow
      }
      if (!target || target.isDestroyed() || target === senderWin) {
        return { ok: false, error: '未找到可注入的目标窗口' }
      }
      try {
        const enterToSend = payload.enterToSend ?? getAppSettings().enterToSend
        target.webContents.send(IPC_CHANNELS.VOICE_INJECT_AND_SEND, {
          text,
          enterToSend,
        })
        // 通知调用方窗口注入成功
        if (senderWin && !senderWin.isDestroyed()) {
          senderWin.webContents.send(IPC_CHANNELS.NOTES_INJECT_RESULT, {
            success: true,
          })
        }
        return { ok: true }
      } catch (err) {
        if (senderWin && !senderWin.isDestroyed()) {
          senderWin.webContents.send(IPC_CHANNELS.NOTES_INJECT_RESULT, {
            success: false,
            error: String(err),
          })
        }
        return { ok: false, error: String(err) }
      }
    },
  )

  // 需求 11：笔记 → 存为提示词
  // 将笔记内容作为新的 PromptTemplate 保存到提示词库。
  // 标题取笔记正文首行（截断 30 字符），分类默认 '笔记'。
  ipcMain.handle(
    IPC_CHANNELS.NOTES_SAVE_AS_PROMPT,
    async (_e, payload: { content: string; title?: string }) => {
      const content = payload?.content ?? ''
      if (!content.trim()) {
        return { ok: false, error: '笔记内容为空' }
      }
      try {
        const title =
          payload.title?.trim() ||
          content.split('\n').map((l) => l.trim()).find((l) => l.length > 0)?.slice(0, 30) ||
          '未命名笔记'
        promptStore.save({
          id: '',
          title,
          content,
          category: '笔记',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        return { ok: true, title }
      } catch (err) {
        return { ok: false, error: String(err) }
      }
    },
  )

  // 从任意窗口推送卡片到白板（v2：定位 active 白板，发送 { whiteboardId, card }）
  // 渲染层收到后插入 tldraw shape；ready 后回 ACK，主进程收到 ACK 后才转发卡片。
  ipcMain.handle(
    IPC_CHANNELS.WHITEBOARD_PUSH_CARD_REQUEST,
    (_e, input: WhiteboardCardInput) => {
      // 定位 active 白板（无则创建"截图收藏"）
      const db = getWhiteboardDb()
      let whiteboardId = db.getActiveWhiteboardId()
      if (!whiteboardId) {
        const wb = db.createWhiteboard('截图收藏')
        whiteboardId = wb.id
        db.setActiveWhiteboardId(wb.id)
      }
      // 生成完整卡片
      const card: WhiteboardCard = {
        id: crypto.randomUUID(),
        type: input.type,
        x: input.x ?? Math.round(Math.random() * 200 + 100),
        y: input.y ?? Math.round(Math.random() * 200 + 100),
        width: input.width,
        height: input.height,
        content: input.content,
        metadata: input.metadata ?? { createdAt: Date.now() },
      }
      // 确保 AI 应用窗口可见
      openAiAppProviderWindow({ initialTab: 'whiteboard' })
      const win = windowState.aiAppProviderWindow
      if (!win || win.isDestroyed()) {
        return card
      }
      // 通知切换到 whiteboard tab，渲染层 ready 后回 ACK，主进程收到 ACK 再发送卡片
      const sendSwitch = () => {
        if (win.isDestroyed()) return
        win.webContents.send(IPC_CHANNELS.AI_APP_PROVIDER_NAVIGATE, { tab: 'whiteboard' })
      }
      if (win.webContents.isLoading()) {
        win.webContents.once('did-finish-load', sendSwitch)
      } else {
        sendSwitch()
      }
      // 入队待推送卡片，等待渲染层 ready 后回 ACK 时统一 flush
      pendingWhiteboardPushes.push({ whiteboardId, card, win })
      return card
    },
  )
  // 渲染层 → 主进程：白板 ready 后回 ACK（send，非 invoke），flush 全部待推送卡片
  ipcMain.on(IPC_CHANNELS.WHITEBOARD_PUSH_ACK, () => {
    while (pendingWhiteboardPushes.length > 0) {
      const push = pendingWhiteboardPushes.shift()!
      if (!push.win.isDestroyed()) {
        push.win.webContents.send(IPC_CHANNELS.WHITEBOARD_PUSH_CARD, {
          whiteboardId: push.whiteboardId,
          card: push.card,
        })
      }
    }
  })

  // 注册设备预设 CRUD IPC + 首次启动填充预置设备预设
  registerPresetsIPC()
  ensureDefaultPresets()

  // 同步开机自启动系统注册状态（每次启动校正一次，避免外部改动导致状态不一致）
  try {
    const settings = getAppSettings()
    applyAutoLaunchSetting(settings.autoLaunch, settings.silentStart)
  } catch (e) {
    console.warn('[main] 同步自启动设置失败:', e)
  }

  // ===== 便携版残留进程检测 =====
  // 便携版可能因上次异常退出残留 SidekickAI.exe 进程（占用文件锁/单实例锁），
  // 弹出独立窗口提示用户"一键清理"或"忽略并继续"。
  // 仅在便携模式 + 非 win32 之外平台跳过（process-guard 仅 win32 实现）。
  if (isPortableMode() && process.platform === 'win32') {
    try {
      const residuals = await detectResidualProcesses()
      if (residuals.length > 0) {
        console.log(`[main] 便携版检测到 ${residuals.length} 个残留进程，弹出清理窗口`)
        const action = await showProcessCleanupWindow(residuals)
        if (action === 'clean') {
          const killed = await killProcesses(residuals.map((p) => p.pid))
          console.log(`[main] 已清理 ${killed.length}/${residuals.length} 个残留进程`)
          // 等待 1 秒让进程完全退出，释放文件锁
          await new Promise((resolve) => setTimeout(resolve, 1000))
        } else {
          console.log('[main] 用户选择忽略残留进程，继续启动')
        }
      }
    } catch (err) {
      // 检测失败不阻塞启动
      console.warn('[main] 便携版残留进程检测失败:', err)
    }
  }

  // 创建主窗口
  createMainWindow()
  // 使用统计：主窗口加载完成后下发窗口类型（供点击日志的 windowType 字段）
  try {
    const mw = windowState.mainWindow
    if (mw && !mw.isDestroyed()) {
      const sendType = () => {
        try {
          mw.webContents.send(IPC_CHANNELS.SET_WINDOW_TYPE, 'main')
        } catch { /* ignore */ }
      }
      if (mw.webContents.isLoading()) {
        mw.webContents.once('did-finish-load', sendType)
      } else {
        sendType()
      }
    }
  } catch { /* ignore */ }

  // 创建系统托盘（必须在静默启动逻辑之前，以便判断托盘是否创建成功）
  createTray()

  // 首次启动引导：onboardingCompleted=false 时弹出引导窗，主窗口保持隐藏
  // 引导窗完成（ONBOARDING_COMPLETE）后显示主窗口并触发 defaultDeepSeek 加载
  // 静默启动（--hidden）时跳过引导，避免弹出引导窗破坏静默语义
  let pendingOnboarding = false
  try {
    pendingOnboarding = !silentStartRequested && !getAppSettings().onboardingCompleted
  } catch (e) {
    console.warn('[main] 读取 onboardingCompleted 失败，跳过引导:', e)
  }
  if (pendingOnboarding && windowState.mainWindow) {
    // createMainWindow 的 ready-to-show 会无条件 show，这里覆盖：引导期间隐藏主窗口
    const mw = windowState.mainWindow
    mw.hide()
    mw.once('ready-to-show', () => mw.hide())
    showOnboardingWindow()
  } else if (silentStartRequested && windowState.mainWindow) {
    // 静默启动：隐藏主窗口到托盘，不显示 onboarding
    // 托盘创建失败时降级为显示主窗口（否则用户无可见入口唤起应用，只能通过任务管理器结束进程）
    const mw = windowState.mainWindow
    if (windowState.trayEnabled) {
      mw.hide()
      mw.once('ready-to-show', () => mw.hide())
    } else {
      console.warn('[main] 静默启动请求但托盘未创建，降级为显示主窗口')
    }
  }

  // ===== 引导 IPC =====
  // ONBOARDING_SHOW：从菜单「使用指南」重新打开引导窗
  ipcMain.handle(IPC_CHANNELS.ONBOARDING_SHOW, () => {
    showOnboardingWindow()
  })
  // ONBOARDING_IS_COMPLETED：引导窗渲染层查询当前状态（决定按钮文案）
  ipcMain.handle(IPC_CHANNELS.ONBOARDING_IS_COMPLETED, () => {
    try {
      return getAppSettings().onboardingCompleted
    } catch {
      return false
    }
  })
  // ONBOARDING_COMPLETE：用户点「开始使用」→ 合并保存快速设置 + 标记完成 + 关闭引导窗 + 显示主窗口
  ipcMain.handle(IPC_CHANNELS.ONBOARDING_COMPLETE, (_e, patch?: Record<string, unknown>) => {
    try {
      updateAppSettings({ onboardingCompleted: true, ...(patch as Partial<ReturnType<typeof getAppSettings>> | undefined) })
    } catch (err) {
      console.error('[main] 保存 onboarding 设置失败:', err)
    }
    // 关闭引导窗
    if (windowState.onboardingWindow && !windowState.onboardingWindow.isDestroyed()) {
      windowState.onboardingWindow.close()
    }
    // 显示主窗口（首次启动时主窗口未 show）
    const mainWin = windowState.mainWindow
    if (mainWin && !mainWin.isDestroyed() && !mainWin.isVisible()) {
      mainWin.show()
      mainWin.focus()
      mainWin.webContents.send(IPC_CHANNELS.WINDOW_SHOWN)
    }
  })

  // ===== 多屏 DPI 缩放处理 =====
  // 监听 display-metrics-changed 仅记录屏幕变化日志。
  // 不再 setZoomFactor(scaleFactor)：系统级 DPI 缩放会与渲染层 CSS [data-ui-scale]
  // 令牌缩放叠加，导致 UI 双重视图缩放。DPI 由 Chromium 默认机制处理，UI 比例
  // 由 CSS 令牌（apps/SidekickAI/src/styles/design-tokens.css）统一控制。
  screen.on('display-metrics-changed', (_e, display, _changedMetrics) => {
    try {
      const targetDisplay = display
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue
        const winBounds = win.getBounds()
        const matched = screen.getDisplayMatching(winBounds)
        if (matched.id === targetDisplay.id) {
          console.log(`[main] display-metrics-changed: window=${win.id} scaleFactor=${targetDisplay.scaleFactor || 1}（不再重设 zoomFactor，由 CSS 令牌控制 UI 比例）`)
        }
      }
    } catch (err) {
      console.error('[main] display-metrics-changed 处理失败:', err)
    }
  })

  // ===== 单实例：第二实例启动时唤醒已有主窗口（不创建新窗口） =====
  app.on('second-instance', () => {
    const win = windowState.mainWindow
    if (!win || win.isDestroyed()) {
      createMainWindow()
      return
    }
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
    // 通知渲染层聚焦输入框
    win.webContents.send(IPC_CHANNELS.WINDOW_SHOWN)
  })

  // 启动只开一个主窗口，脱离窗口必须由用户手动拖动标签页到窗口外才创建
  // （不自动恢复上次的脱离窗口，避免启动时打开多个窗口）

  // ===== 注册 Profile CRUD IPC =====
  registerProfileIPC()

  // ===== 注册提示词模板 CRUD IPC =====
  registerPromptIPC()

  // ===== 注册自定义 AI 提供商 CRUD + 对话持久化 IPC =====
  registerAIProviderIPC()
  ensureDefaultProviders()
  registerAIChatIPC()

  // ===== 一次性数据迁移：electron-store JSON → SQLite（幂等） =====
  migrateWhiteboardNotes()

  // ===== 灵感笔记 IPC（v2：SQLite + FTS5） =====
  registerNotesIPC()

  // ===== 白板 IPC（v2：SQLite + tldraw + 多白板） =====
  registerWhiteboardIPC()
  registerWhiteboardAssetIPC()

  // ===== 注册语音配置 IPC（enterToSend 等） =====
  registerVoiceConfigIPC()
  registerAppSettingsIPC()

  // ===== 挂载下载监听到 defaultSession + 所有 profile partitions =====
  // 新建 Profile 时由 profile-store.ts 的 PROFILE_CREATE 处理器单独挂载
  attachDownloadHandlersForAllProfiles()

  // ===== 启动时按 cacheAutoClean 频率判定是否触发自动缓存清理 =====
  // 仅判定一次，不引入常驻定时器；异步执行不阻塞主流程
  void maybeAutoCleanCache()

  // ===== 注册全局代理认证处理器（app.on('login') 处理 407 代理认证） =====
  registerProxyAuthHandler()

  // ===== 注册窗口控制 IPC（窗口控制/管理/状态/chat脱离/指纹） =====
  registerWindowControlIpc({
    windowManager,
    fingerprintEngine,
    getSenderWindow,
    findWindowIdByWin,
    createChatWindow,
    showHistoryWindow,
    getDetachedWindow: (windowId: string) => windowState.detachedWindows.get(windowId),
  })

  // ===== 注册标签 IPC（标签 CRUD + DETACH_TAB） =====
  registerTabIpc({
    windowManager,
    getSenderWindow,
    findWindowIdByWin,
    createStandaloneWindow,
  })

  // ===== 注册提示词库窗口 IPC（PROMPT_OPEN_WINDOW + 注入请求/结果转发） =====
  registerPromptIpc({
    showPromptWindow,
    getMainWindow: () => windowState.mainWindow,
    getPromptWindow: () => windowState.promptWindow,
  })

  // ===== 注册预设与 AI 平台查询 IPC =====
  registerSettingsIpc()

  // ===== 注册平台能力查询 IPC（设置页显示权限状态） =====
  registerPlatformInfoIPC()

  // ===== 注册语音识别（STT）IPC =====
  registerVoiceIpc({ sttEngine, startBackgroundVoice, stopBackgroundVoice })

  // ===== 注册热键 IPC + 内置热键回调 + 语音热键 =====
  registerHotkeyIpc({
    hotkeyManager,
    getMainWindow: () => windowState.mainWindow,
    toggleAiAppProviderWindow,
    startBackgroundVoice,
    stopBackgroundVoice,
  })

  // ===== 启动后延迟检测 uiohook 健康度 =====
  // uiohook 是低层键盘钩子，可能因权限不足/安全软件拦截/驱动冲突而启动失败
  // 启动后 2 秒检测一次状态，失败时通过系统通知 + 渲染层双通道告知用户
  setTimeout(() => {
    const status = hotkeyManager.getStatus()
    console.log('[main] 启动后状态检查:', JSON.stringify(status))
    if (!status.uiohookStarted) {
      const title = '语音热键未就绪'
      let body =
        '后台键盘监听（uiohook）启动失败，Alt+V 等语音热键将无法使用。'
      if (process.platform === 'darwin') {
        body +=
          '\nmacOS 需要授予「辅助功能」权限：系统设置 > 隐私与安全性 > 辅助功能，添加本应用。'
      } else {
        body +=
          '可能原因：被安全软件拦截、权限不足、驱动冲突。\n' +
          '请检查后重启应用，或在设置中查看详情。'
      }
      console.error('[main] uiohook 未启动：', body)
      showNotification(title, body)
      // 同步通知渲染层
      const mainWin = windowState.mainWindow
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send(IPC_CHANNELS.HOTKEY_STATUS, status)
      }
    } else {
      console.log('[main] uiohook 启动成功，热键就绪')
    }
  }, 2000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
}).catch((err) => {
  console.error('[main] app.whenReady() 失败:', err)
})

app.on('window-all-closed', () => {
  // 有托盘时不退出，托盘可恢复窗口
  if (tray) return
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  // 标记应用正在退出，主窗口 close 事件不再拦截（避免 minimize 模式阻止退出）
  ;(app as unknown as { isQuitting: boolean }).isQuitting = true
  hotkeyManager?.unregisterAll()
  sttEngine?.cleanup()
  cleanupActiveStreams()
  // 使用统计：记录退出时间（在 closeChatStore 之前调用，确保 db 仍可用）
  try {
    if (getAppSettings().usageTrackingEnabled) {
      getChatStore().logAppEnd()
    }
  } catch (e) {
    console.warn('[main] logAppEnd 失败:', e)
  }
  closeChatStore()
  // 销毁托盘
  if (tray) {
    tray.destroy()
    tray = null
    windowState.trayEnabled = false
  }
  // 销毁预览窗（避免进程残留）
  if (windowState.previewWindow && !windowState.previewWindow.isDestroyed()) {
    windowState.previewWindow.destroy()
    windowState.previewWindow = null
  }
  // 清理挂起的剪贴板恢复定时器（避免退出后仍尝试写剪贴板）
  if (clipboardRestoreTimer) {
    clearTimeout(clipboardRestoreTimer)
    clipboardRestoreTimer = null
  }
  // 销毁历史搜索窗（避免进程残留）
  if (windowState.historyWindow && !windowState.historyWindow.isDestroyed()) {
    windowState.historyWindow.destroy()
    windowState.historyWindow = null
  }
  // 销毁提示词库窗（避免进程残留）
  if (windowState.promptWindow && !windowState.promptWindow.isDestroyed()) {
    windowState.promptWindow.destroy()
    windowState.promptWindow = null
  }
  // 销毁 AI 应用独立窗（避免进程残留）
  if (windowState.aiAppProviderWindow && !windowState.aiAppProviderWindow.isDestroyed()) {
    windowState.aiAppProviderWindow.destroy()
    windowState.aiAppProviderWindow = null
  }
  // 销毁引导窗（避免进程残留）
  if (windowState.onboardingWindow && !windowState.onboardingWindow.isDestroyed()) {
    windowState.onboardingWindow.destroy()
    windowState.onboardingWindow = null
  }
  // 销毁所有 AI 应用编辑窗（避免进程残留）
  if (windowState.aiAppEditorWindows.size > 0) {
    for (const [, w] of windowState.aiAppEditorWindows) {
      if (!w.isDestroyed()) w.destroy()
    }
    windowState.aiAppEditorWindows.clear()
  }
  if (previewHideTimer) {
    clearTimeout(previewHideTimer)
    previewHideTimer = null
  }
  // 兜底：强制关闭所有尚未关闭的窗口，确保进程退出
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.close()
  }
})
