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
// 便携模式检测。
//
// 后台语音（预览窗 + STT + 上屏）、系统托盘、引导/笔记额外 IPC、退出清理
// 已分别抽离到 electron/voice/、electron/window/tray.ts、electron/ipc/、
// electron/lifecycle.ts，本文件仅做 bootstrap 编排。

import { app, BrowserWindow, Menu, ipcMain, protocol, screen, session, systemPreferences } from 'electron'
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
import { registerWhiteboardIPC } from './store/whiteboard-db.js'
import { registerWhiteboardAssetIPC } from './store/whiteboard-asset-store.js'
import { registerNotesAssetIPC } from './store/notes-asset-store.js'
import { migrateWhiteboardNotes } from './store/migrate-whiteboard-notes.js'
import { registerVoiceConfigIPC } from './store/voice-store.js'
import { registerAppSettingsIPC, getAppSettings, applyAutoLaunchSetting } from './store/app-settings-store.js'
import { registerProxyAuthHandler } from './store/proxy-helper.js'
import { initChatStore, getChatStore } from './store/chat-store.js'
import { registerAIChatIPC } from './ai/handler.js'
import { WindowManager } from './window/manager.js'
import { FingerprintEngine } from './fingerprint/engine.js'
import { HotkeyManager } from './hotkey/manager.js'
import { SttEngine } from './stt/engine.js'
import { IPC_CHANNELS } from './shared/types.js'
import { registerWindowControlIpc } from './ipc/window-control-ipc.js'
import { registerTabIpc } from './ipc/tab-ipc.js'
import { registerHotkeyIpc } from './ipc/hotkey-ipc.js'
import { registerVoiceIpc } from './ipc/voice-ipc.js'
import { registerPromptIpc } from './ipc/prompt-ipc.js'
import { registerSettingsIpc } from './ipc/settings-ipc.js'
import { registerNotesExtraIpc } from './ipc/notes-ipc.js'
import { registerOnboardingIpc } from './ipc/onboarding-ipc.js'
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
  openAdvancedPanelWindow,
  toggleAdvancedPanelWindow,
  showOnboardingWindow,
  setOnboardingLifecycleCallbacks,
  showProcessCleanupWindow,
  getSenderWindow,
  findWindowIdByWin,
} from './window-factory.js'
import { isPortableMode } from './store/store-paths.js'
import { detectResidualProcesses, killProcesses } from './utils/process-guard.js'
import { initAppFocusTracker } from './voice/preview-window.js'
import {
  startBackgroundVoice as startBackgroundVoiceImpl,
  stopBackgroundVoice as stopBackgroundVoiceImpl,
} from './voice/background-voice.js'
import { createTray, hasTray } from './window/tray.js'
import { cleanupOnQuit, runUiohookHealthCheck } from './lifecycle.js'

/** 主窗口默认宽度（窗口复位时使用） */
const DEFAULT_MAIN_WINDOW_WIDTH = 420
/** 主窗口默认高度（窗口复位时使用） */
const DEFAULT_MAIN_WINDOW_HEIGHT = 820

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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
  { scheme: 'notes-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
])

// 全局管理器实例（fingerprintEngine/hotkeyManager/sttEngine 仅本文件使用；
// windowManager 已迁入 windowState，因 window-factory.ts 的窗口创建函数需读取）
let fingerprintEngine: FingerprintEngine
let hotkeyManager: HotkeyManager
let sttEngine: SttEngine

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
  // 打开 进阶面板（单例，承载内置 AI/自定义供应商/自定义对话）
  // 可选 providerId：若提供则切换到对应供应商的对话页
  ipcMain.handle(IPC_CHANNELS.ADVANCED_PANEL_OPEN, (_e, providerId?: string) => {
    openAdvancedPanelWindow(providerId ? { providerId, initialTab: 'chat' } : undefined)
  })
  // 切换 进阶面板显隐（单例，Alt+Q 入口）
  // v0.5.2：Alt+Q 始终打开 进阶面板，笔记/白板作为该窗口的视图模式
  ipcMain.handle(IPC_CHANNELS.ADVANCED_PANEL_TOGGLE, () => {
    toggleAdvancedPanelWindow()
  })

  // 笔记额外 IPC：NOTES_SEND_TO_AI（注入到 AI 输入框）+ NOTES_SAVE_AS_PROMPT（存为提示词）
  registerNotesExtraIpc()

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

  // 引导相关 IPC（ONBOARDING_SHOW / ONBOARDING_IS_COMPLETED / ONBOARDING_COMPLETE）
  registerOnboardingIpc()

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

  // ===== 笔记图片资产 IPC（notes-asset:// 协议 + 图片保存） =====
  registerNotesAssetIPC()

  // ===== 白板 IPC（v3：SQLite + Excalidraw + 多白板） =====
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
  // background-voice.ts 的 startBackgroundVoice/stopBackgroundVoice 接收 sttEngine 参数，
  // 此处用箭头包装为无参函数以匹配 registerVoiceIpc 期望的签名。
  registerVoiceIpc({
    sttEngine,
    startBackgroundVoice: () => startBackgroundVoiceImpl(sttEngine),
    stopBackgroundVoice: () => stopBackgroundVoiceImpl(sttEngine),
  })

  // ===== 注册热键 IPC + 内置热键回调 + 语音热键 =====
  registerHotkeyIpc({
    hotkeyManager,
    getMainWindow: () => windowState.mainWindow,
    toggleAdvancedPanelWindow,
    startBackgroundVoice: () => startBackgroundVoiceImpl(sttEngine),
    stopBackgroundVoice: () => stopBackgroundVoiceImpl(sttEngine),
  })

  // ===== 启动后延迟检测 uiohook 健康度 =====
  // uiohook 是低层键盘钩子，可能因权限不足/安全软件拦截/驱动冲突而启动失败
  // 启动后 2 秒检测一次状态，失败时通过系统通知 + 渲染层双通道告知用户
  runUiohookHealthCheck(hotkeyManager)

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
  if (hasTray()) return
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  cleanupOnQuit({ hotkeyManager, sttEngine })
})
