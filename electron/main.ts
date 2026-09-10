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
import { mkdirSync, existsSync } from 'fs'
import {
  registerProfileIPC,
  ensureDefaultProfiles,
} from './store/profile-store.js'
import {
  registerBlockRulesIPC,
  ensureDefaultBlockRules,
} from './store/block-rules-store.js'
import {
  registerPresetsIPC,
  ensureDefaultPresets,
} from './store/preset-store.js'
import { registerPdfProtocol } from './utils/pdf-protocol.js'
import { setCloudPcHotkeyManager, isCloudPc } from './utils/cloud-pc.js'
import { setBrowserHotkeyFallback, tryForward, VK_F11, VK_C, VK_P } from './utils/browser-hotkey-fallback.js'
import { registerAppSettingsIPC, getAppSettings, applyAutoLaunchSetting, updateAppSettings } from './store/app-settings-store.js'
import { seedFromInstallConfig } from './store/install-config-seed.js'
import { registerProxyAuthHandler } from './store/proxy-helper.js'
import { initChatStore, getChatStore } from './store/chat-store.js'
import { registerBaseChatIpc, registerUsageTraceIpc } from './ai/handler.js'
import { WindowManager } from './window/manager.js'
import { FingerprintEngine } from './fingerprint/engine.js'
import { HotkeyManager } from './hotkey/manager.js'
import { SttEngine } from './stt/engine.js'
import { IPC_CHANNELS } from './shared/types.js'
import { registerWindowControlIpc } from './ipc/window-control-ipc.js'
import { registerTabIpc } from './ipc/tab-ipc.js'
import { registerAccumulatedLinksIpc } from './ipc/accumulated-links-ipc.js'
import { registerHotkeyIpc } from './ipc/hotkey-ipc.js'
import { registerSettingsIpc } from './ipc/settings-ipc.js'
import { registerOnboardingIpc } from './ipc/onboarding-ipc.js'
import { promptAccessibilityPermission } from './utils/permission-manager.js'
import { registerPlatformInfoIPC } from './utils/platform-info.js'
import { attachDownloadHandlersForAllProfiles, maybeAutoCleanCache } from './utils/download-handler.js'
import { windowState } from './window-state.js'
import { windowStore } from './store/window-store.js'
import { isTrackedFullscreen } from './utils/fullscreen-tracker.js'
import {
  createMainWindow,
  createBrowserWindow,
  createChatWindow,
  showHistoryWindow,
  showPromptWindow,
  showAiAppEditorWindow,
  showSettingsWindow,
  showHistoryDownloadWindow,
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
  peekSttEngine,
  startBackgroundVoiceGated,
  stopBackgroundVoiceGated,
  toggleVoiceRecordingGated,
} from './modules/wiring/voice.js'
import { createTray, hasTray } from './window/tray.js'
import { cleanupOnQuit, runUiohookHealthCheck } from './lifecycle.js'
import { BUILTIN_MODULES } from './modules/manifests.js'
import { initEnabledModules, registerModule, isModuleEnabled, listManifests } from './modules/registry.js'
import { loadBuiltinPlugins } from './modules/plugin-loader.js'
import { registerModuleIpc } from './ipc/module-ipc.js'
import { closeModuleStateDb } from './store/module-state-store.js'
import { capabilityRegistry } from './modules/capability-registry.js'
import { injectionBroker } from './modules/injection-broker.js'
import { allAdapters } from './modules/adapters/index.js'
import { extractCapabilities } from './modules/capability.js'
import { registerVoiceConfigIPC } from './store/voice-store.js'
import { registerAIProviderIPC } from './store/ai-provider-store.js'
import { registerPromptIPC } from './store/prompt-store.js'

/** 主窗口默认宽度（窗口复位时使用） */
const DEFAULT_MAIN_WINDOW_WIDTH = 420
/** 主窗口默认高度（窗口复位时使用） */
const DEFAULT_MAIN_WINDOW_HEIGHT = 820

const __dirname = path.dirname(__filename)

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
// 云游戏/网页游戏手柄支持：关闭 Chromium 的 RestrictGamepadAccess 限制。
// 默认情况下 navigator.getGamepads() 与 gamepadconnected 事件要求页面先获得
// 用户激活（user activation），否则返回空数组、事件不派发——表现为「手柄无法识别」。
// 关闭后手柄连接即可被页面立即感知（Gamepad API 无需额外原生模块）。
app.commandLine.appendSwitch('disable-features', 'RestrictGamepadAccess')
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
    } else {
      console.log('[main] Production install mode: userData =', app.getPath('userData'))
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
  { scheme: 'sidekick-pdf', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
])

// 全局管理器实例（fingerprintEngine/hotkeyManager/sttEngine 仅本文件使用；
// windowManager 已迁入 windowState，因 window-factory.ts 的窗口创建函数需读取）
let fingerprintEngine: FingerprintEngine
let hotkeyManager: HotkeyManager

/**
 * 应用就绪：初始化所有管理器并注册 IPC
 */
app.whenReady().then(async () => {
  // 移除默认应用菜单：释放 F12（默认 toggleDevTools）等系统级快捷键，
  // 交由应用内 keydown / before-input-event 统一处理。
  // DevTools 可通过 --dev-tools 启动参数或 DEV_TOOLS=1 环境变量打开（见下方 autoOpenDevTools）。
  Menu.setApplicationMenu(null)

  // ===== 安装期配置播种 =====
  // 首次启动读取 NSIS 落盘的 install-config.json，把安装向导中选择的功能开关
  // 与应用选项写入 settings.db（仅一次）。必须在 initEnabledModules() 与任何
  // getAppSettings() 之前执行，否则模块状态/默认设置已按旧值初始化。
  seedFromInstallConfig()

  // --dev-tools 启动参数：启动后自动为所有新窗口打开 DevTools（调试模式）
  const autoOpenDevTools = process.argv.includes('--dev-tools') || process.env.DEV_TOOLS === '1'
  if (autoOpenDevTools) {
    console.log('[main] DevTools 调试模式：新窗口将自动打开 DevTools')
    windowState.autoOpenDevTools = true
  }

  // --hidden 启动参数：由开机自启动注入，启动后隐藏到托盘不显示主窗口
  const silentStartRequested = process.argv.includes('--hidden')
  // 安装向导注入：--show-guide = 安装后打开使用指南（强制显示引导窗）
  const showGuideRequested = process.argv.includes('--show-guide')
  // 安装向导注入：--skip-guide = 安装后跳过使用指南（标记引导完成，不再默认弹出）
  const skipGuideRequested = process.argv.includes('--skip-guide')

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
  setCloudPcHotkeyManager(hotkeyManager)

  // ===== 浏览器窗口快捷键 uiohook 兜底通道 =====
  // guest before-input-event 对 Alt 组合（Ctrl+Alt+C / Alt+P）与全屏状态的拦截
  // 在部分环境不可靠；uiohook 为系统级键盘钩子，作为第二通道。
  // 双通道通过 tryForward 去重（同一 action 250ms 内仅一条生效）。
  setBrowserHotkeyFallback((e) => {
    // 仅处理前台聚焦的浏览器窗口
    let browserWin: Electron.BrowserWindow | null = null
    for (const win of windowState.browserWindowsByProfile.values()) {
      if (win && !win.isDestroyed() && win.isFocused()) {
        browserWin = win
        break
      }
    }
    if (!browserWin) return
    const win = browserWin

    // Ctrl+Alt+C：进入/退出云电脑模式（云电脑模式下也是退出手段，始终生效）
    if (e.keycode === VK_C && e.ctrl && e.alt && !e.shift && !e.meta) {
      if (tryForward('toggleCloudPc')) {
        console.log('[hotkey-fallback] Ctrl+Alt+C → 切换云电脑模式 (uiohook)')
        win.webContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'toggleCloudPc' })
      }
      return
    }

    // 云电脑模式：其余浏览器快捷键放行给远端（不拦截）
    if (isCloudPc(win.webContents.id)) return

    // F11：切换沉浸式全屏（主进程直接执行，不依赖渲染层/guest 拦截）
    if (e.keycode === VK_F11 && !e.ctrl && !e.alt && !e.shift && !e.meta) {
      if (tryForward('toggleFullscreen')) {
        const wid = findWindowIdByWin(win)
        const wasFs = wid ? isTrackedFullscreen(wid) : win.isFullScreen()
        console.log('[hotkey-fallback] F11 → 切换沉浸式全屏 (uiohook), wasFullScreen=', wasFs)
        if (!wasFs) {
          // 进入全屏前保存 bounds
          if (wid) {
            const state = windowStore.getOrDefault(wid)
            state.fullscreenNormalBounds = win.getBounds()
            windowStore.save(wid, state)
          }
        }
        try { win.setFullScreen(!wasFs) } catch { /* ignore */ }
      }
      return
    }

    // Alt+P：冻结/恢复当前页面
    if (e.keycode === VK_P && e.alt && !e.ctrl && !e.shift && !e.meta) {
      if (tryForward('toggleFreeze')) {
        console.log('[hotkey-fallback] Alt+P → 冻结切换 (uiohook)')
        win.webContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'toggleFreeze' })
      }
      return
    }
  })

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

  // ===== 模块管理（插件系统）：注册 manifest → 状态入库 → 按状态执行 init =====
  // 规范：docs/功能插件系统与安装管控方案.md 第 11 章；状态存 SQLite settings.db（决策 0.4）。
  // 启动即隔离：禁用模块的 init 不会执行，重启后依然（11.10 硬保证）。
  BUILTIN_MODULES.forEach((m) => registerModule(m))

  // 加载内置插件（electron/modules/plugins/ 目录自动发现）
  const builtinPlugins = await loadBuiltinPlugins()
  builtinPlugins.forEach((m) => registerModule(m))

  registerModuleIpc()

  // ===== 统一注入管线初始化 =====
  // 注册所有 TargetAdapter 到 InjectionBroker
  injectionBroker.registerAdapters(allAdapters)
  // 从所有已注册 manifest（含插件）中提取能力声明并注册到 CapabilityRegistry
  const capabilities = extractCapabilities(listManifests())
  if (capabilities.length > 0) {
    capabilityRegistry.registerMany(capabilities)
    console.log(`[main] 已注册 ${capabilities.length} 个能力声明`)
  }

  await initEnabledModules()

  // ===== 核心 IPC 注册（模块未启用时才注册，避免重复） =====
  // 语音配置 IPC：设置页需要读取语音配置，即使语音模块未启用
  if (!isModuleEnabled('voice')) {
    registerVoiceConfigIPC()
  }
  // AI Provider IPC：底栏需要显示 AI Provider 列表，即使自定义对话模块未启用
  if (!isModuleEnabled('custom-chat')) {
    registerAIProviderIPC()
  }
  // 提示词库 IPC：设置页和底栏需要读取提示词列表，即使提示词库模块未启用
  if (!isModuleEnabled('prompt-library')) {
    registerPromptIPC()
  }

  // 首次启动创建默认 AI 平台 Profile
  ensureDefaultProfiles()

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
  // 打开设置独立窗口（单例，左导航+右内容布局）
  ipcMain.handle(IPC_CHANNELS.SETTINGS_WINDOW_OPEN, () => {
    showSettingsWindow()
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
  // 安装向导注入：--show-guide 强制打开使用指南（即使已标记完成）；
  //              --skip-guide 跳过引导并标记完成（安装版默认不弹指南）
  let pendingOnboarding = showGuideRequested
  try {
    if (!pendingOnboarding && !skipGuideRequested && !silentStartRequested) {
      pendingOnboarding = !getAppSettings().onboardingCompleted
    }
    if (skipGuideRequested && !getAppSettings().onboardingCompleted) {
      updateAppSettings({ onboardingCompleted: true })
    }
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
    win.setSkipTaskbar(false)
    if (!win.isVisible()) win.show()
    win.focus()
    // 通知渲染层聚焦输入框
    win.webContents.send(IPC_CHANNELS.WINDOW_SHOWN)
  })

  // 启动只开一个主窗口，脱离窗口必须由用户手动拖动标签页到窗口外才创建
  // （不自动恢复上次的脱离窗口，避免启动时打开多个窗口）

  // ===== 注册 Profile CRUD IPC =====
  registerProfileIPC()

  // ===== 对话/痕迹基础 IPC（历史搜索 FTS5、登录/窗口痕迹、最近对话、用量统计） =====
  registerBaseChatIpc()

  // ===== 使用统计与操作日志 IPC（基础功能，独立于自定义对话模块） =====
  registerUsageTraceIpc()

  registerPdfProtocol()
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
  })

  // ===== 注册标签 IPC（标签 CRUD + DETACH_TAB） =====
  registerTabIpc({
    windowManager,
    getSenderWindow,
    findWindowIdByWin,
    createBrowserWindow,
  })

  // ===== 注册累积链接 IPC（E1：AI 应用内新窗口链接累积，基础功能） =====
  registerAccumulatedLinksIpc()

  // ===== 注册预设与 AI 平台查询 IPC =====
  registerSettingsIpc()

  // ===== 注册平台能力查询 IPC（设置页显示权限状态） =====
  registerPlatformInfoIPC()

  // ===== 注册热键 IPC + 内置热键回调 + 语音热键 =====
  // 语音回调经 wiring/voice 门控：语音模块未启用时全部 no-op（Alt+V 无法触发任何行为）
  registerHotkeyIpc({
    hotkeyManager,
    getMainWindow: () => windowState.mainWindow,
    toggleAdvancedPanelWindow,
    startBackgroundVoice: startBackgroundVoiceGated,
    stopBackgroundVoice: stopBackgroundVoiceGated,
    toggleVoiceRecording: toggleVoiceRecordingGated,
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
  // 导入数据进行中时不退出（窗口已销毁但流程未完成）
  const { isImportingData } = require('./store/import-guard.js')
  if (isImportingData) return
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  closeModuleStateDb()
  cleanupOnQuit({ hotkeyManager, sttEngine: peekSttEngine() })
})
