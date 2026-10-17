import type { AppSettings } from '../shared/api/settings.api.js'

export type DefaultAppSettings = AppSettings

// 本模块禁止引入任何运行时依赖（见 scripts/architecture-check.mjs 的
// "State/defaults import runtime behavior"），因此这两组取值只能就地声明。
// 它们必须与 electron/shared/api/settings-options.ts 保持一致：
// 该叶子模块定义同一批字面量，设置校验依赖它；此处一旦漂移，
// 默认值将无法通过自己的校验器。
const DEFAULT_TOP_BAR_BUTTON_GROUPS: AppSettings['topBarVisibleButtons'] = [
  'uaToggle', 'navBack', 'navForward', 'navHome', 'themeToggle', 'pinToggle',
]

const DEFAULT_DRAWER_MENU_ITEMS: AppSettings['drawerMenuItems'] = [
  'advancedPanel', 'promptLibrary', 'settings', 'network', 'modules', 'manage',
  'backup', 'logs', 'detach', 'onboarding', 'shortcuts', 'themeToggle',
]

export function getDefaultAppSettings(isPortable: boolean): DefaultAppSettings {
  return {
    hideForeignModels: true,
    tabBarCollapsed: true,
    proxyMode: 'system',
    customProxy: '',
    proxyUsername: '',
    proxyPassword: '',
    proxyBypass: '',
    hiddenPlatforms: [],
    enterToSend: true,
    defaultDesktopUaPreset: 'win-chrome-125',
    defaultMobileUaPreset: 'iphone-15-pro-safari',
    // Installed applications keep their tray session by default.
    closeBehavior: isPortable ? 'close' : 'minimize',
    autoLaunch: false,
    silentStart: false,
    autoUpdate: true,
    logLevel: 'info',
    uiScale: 'medium',
    themeMode: 'light',
    startupOpen: 'lastConversation',
    onboardingCompleted: false,
    topBarVisibleButtons: [...DEFAULT_TOP_BAR_BUTTON_GROUPS],
    drawerMenuItems: [...DEFAULT_DRAWER_MENU_ITEMS],
    appClickBehavior: 'switch',
    cacheAutoClean: 'never',
    lastCacheCleanAt: 0,
    downloadDir: '',
    downloadBehavior: 'ask',
    altSpaceResetThreshold: 6,
    proxyFallbackEnabled: false,
    proxyFallbackMode: 'direct',
    usageTrackingEnabled: true,
    cookieWhitelist: ['google.com', 'openai.com'],
    cookieBlacklist: [],
    cookiePopupCooldownMs: 60000,
    cookieHandlerEnabled: true,
    defaultAdvancedPanelTab: 'chat',
    whiteboardSidebarVisible: false,
    disableAllBlockRules: false,
    notesSidebarWidth: 160,
    notesSidebarCollapsed: false,
    notesRestoreCursor: true,
    chatSidebarWidth: 130,
    chatSidebarCollapsed: false,
    chatInputCursorPos: 0,
    advancedPanelTabSwitchShortcuts: true,
    whiteboardSidebarWidth: 130,
    whiteboardSidebarCollapsed: false,
    popupWhitelist: [],
    browserTabPersistence: 'memory',
    // 开发者可一键启用空闲回收；默认关闭，已加载页面保持挂载。
    lowMemoryMode: false,
    defaultSearchEngine: { name: 'Bing', urlTemplate: 'https://www.bing.com/search?q={query}' },
  }
}
