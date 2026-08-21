// electron/store/default-config.ts — 统一默认配置路由器
//
// 所有"默认值是什么？"的问题都经过此文件路由：
//   用户设置了偏好 → 使用用户偏好
//   用户没设置     → 自动使用第一个代码项
//
// 各 Store 通过 import 调用路由函数，不在本地做默认值逻辑。

import type { TopBarButtonGroup } from '../shared/types.js'
import type { BlockRule } from '../shared/block-rules.types.js'
import type { DevicePreset, PromptTemplate, Profile } from '../shared/types.js'
import { AI_PLATFORMS } from '../presets/ai-platforms.js'
import { IPHONE_VIEWPORT } from '../presets/devices.js'
import type { VoiceConfig } from './voice-store.js'

// =============================================================================
// 路由器核心
// =============================================================================

/**
 * 通用配置路由器：从列表中返回用户偏好的项，或第一个代码项。
 * 这是所有"默认值解析"的唯一入口。
 */
export function getDefault<T extends { id: string }>(
  items: T[],
  userPreferredId?: string | null,
): T {
  if (userPreferredId) {
    const found = items.find((item) => item.id === userPreferredId)
    if (found) return found
  }
  return items[0]
}

/**
 * 用户偏好键名常量（存储在 MetaTable / AppSettings 中的 key）
 * 各 Store 使用这些常量读写用户偏好，避免硬编码字符串。
 */
export const PREF_KEYS = {
  /** 用户偏好的桌面端 UA 预设 ID */
  desktopUaPreset: 'defaultDesktopUaPreset',
  /** 用户偏好的移动端 UA 预设 ID */
  mobileUaPreset: 'defaultMobileUaPreset',
  /** 用户偏好的默认高级面板 Tab */
  advancedPanelTab: 'defaultAdvancedPanelTab',
  /** 用户偏好的搜索引擎 */
  searchEngine: 'defaultSearchEngine',
} as const

// =============================================================================
// AppSettings 默认值
// =============================================================================

/**
 * 应用设置完整接口（从 app-settings-store.ts 提取，保持类型一致性）
 */
export interface DefaultAppSettings {
  hideForeignModels: boolean
  tabBarCollapsed: boolean
  proxyMode: 'system' | 'direct' | 'custom'
  customProxy: string
  proxyUsername: string
  proxyPassword: string
  proxyBypass: string
  hiddenPlatforms: string[]
  enterToSend: boolean
  defaultDesktopUaPreset: string
  defaultMobileUaPreset: string
  closeBehavior: 'close' | 'minimize'
  autoLaunch: boolean
  silentStart: boolean
  uiScale: 'small' | 'medium' | 'large'
  startupOpen: 'home' | 'lastConversation'
  onboardingCompleted: boolean
  topBarVisibleButtons: TopBarButtonGroup[]
  appClickBehavior: 'switch' | 'close'
  cacheAutoClean: 'never' | 'daily' | 'weekly' | 'monthly'
  lastCacheCleanAt: number
  downloadDir: string
  downloadBehavior: 'ask' | 'auto'
  altSpaceResetThreshold: number
  proxyFallbackEnabled: boolean
  proxyFallbackMode: 'direct' | 'system'
  usageTrackingEnabled: boolean
  cookieWhitelist: string[]
  cookieBlacklist: string[]
  cookiePopupCooldownMs: number
  cookieHandlerEnabled: boolean
  defaultAdvancedPanelTab: 'chat' | 'whiteboard' | 'notes'
  whiteboardSidebarVisible: boolean
  disableAllBlockRules: boolean
  notesSidebarWidth: number
  notesSidebarCollapsed: boolean
  notesRestoreCursor: boolean
  chatSidebarWidth: number
  chatSidebarCollapsed: boolean
  chatInputCursorPos: number
  advancedPanelTabSwitchShortcuts: boolean
  whiteboardSidebarWidth: number
  whiteboardSidebarCollapsed: boolean
  popupWhitelist: string[]
  browserTabPersistence: 'memory' | 'persistent'
  defaultSearchEngine: {
    name: string
    urlTemplate: string
  }
}

/**
 * 获取默认应用设置。
 * 唯一模式差异：closeBehavior —— 便携版默认直接关闭，安装版默认最小化到托盘。
 *
 * @param isPortable 是否为便携模式（由调用方传入，避免运行时依赖）
 */
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
    // 安装版默认最小化到托盘，便携版默认直接关闭
    closeBehavior: isPortable ? 'close' : 'minimize',
    autoLaunch: false,
    silentStart: false,
    uiScale: 'medium',
    startupOpen: 'lastConversation',
    onboardingCompleted: false,
    topBarVisibleButtons: ['navBack', 'navForward', 'navHome', 'pinToggle'],
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
    defaultSearchEngine: { name: 'Bing', urlTemplate: 'https://www.bing.com/search?q={query}' },
  }
}

// =============================================================================
// 路由便捷函数：各 Store 调用这些函数获取默认值
// =============================================================================

/**
 * 路由：获取默认桌面端 UA 预设。
 * 用户在 AppSettings.defaultDesktopUaPreset 中保存偏好 ID，未设置则返回 PRESETS[0]。
 */
export function resolveDefaultDesktopPreset(desktopUaPresetId: string): DevicePreset {
  return getDefault(PRESETS, desktopUaPresetId)
}

/**
 * 路由：获取默认移动端 UA 预设。
 * 用户在 AppSettings.defaultMobileUaPreset 中保存偏好 ID，未设置则返回 PRESETS[2]（iPhone）。
 * 注意：移动端特殊处理——第一个 PRESETS 项是桌面端，所以这里用 PRESETS[2] 作为无偏好时的 fallback。
 */
export function resolveDefaultMobilePreset(mobileUaPresetId: string): DevicePreset {
  // 移动端预设从 PRESETS 中按 platform='mobile' 过滤后取第一个，或直接用用户偏好
  if (mobileUaPresetId) {
    const found = PRESETS.find((p) => p.id === mobileUaPresetId)
    if (found) return found
  }
  return PRESETS.find((p) => p.platform === 'mobile') ?? PRESETS[0]
}

/**
 * 路由：获取默认提示词模板。
 * 从 PROMPTS 列表中返回用户偏好的模板，或第一个模板。
 * 注意：PromptTemplate 在存储时有 id 字段，但 PROMPTS 定义时没有。
 * 此函数用于新建模板时的默认值参考。
 */
export function getDefaultPromptTemplate(): Omit<PromptTemplate, 'id' | 'createdAt' | 'updatedAt'> {
  return PROMPTS[0]
}

// =============================================================================
// Block Rules（第一个元素即默认规则）
// =============================================================================

/** 预置屏蔽规则（id 使用固定值便于幂等填充） */
export const BLOCK_RULES: BlockRule[] = [
  // ===== 通用规则（所有域名） =====
  {
    id: 'builtin-block-confirm-alert',
    domainPattern: '*',
    type: 'js',
    selector: '',
    jsCode: `window.confirm = function() { return true; }; window.alert = function() {}; window.prompt = function() { return null; };`,
    label: '屏蔽原生弹窗（confirm/alert/prompt）',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin-generic-sidebar-ads',
    domainPattern: '*',
    type: 'css',
    selector: '[class*="ad-banner"], [class*="ad-container"], [id*="ad-banner"], [class*="sidebar-ad"], [class*="ad-slot"], [id*="ad-container"]',
    label: '通用侧边栏广告屏蔽',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin-generic-upgrade-modal',
    domainPattern: '*',
    type: 'css',
    selector: '[class*="upgrade-modal"], [class*="pro-modal"], [class*="premium-banner"], [class*="upgrade-banner"], [class*="pro-banner"]',
    label: '通用升级/付费弹窗屏蔽',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin-block-beforeunload',
    domainPattern: '*',
    type: 'js',
    selector: '',
    jsCode: `(function() { window.onbeforeunload = null; if (!window.__ai_beforeunload_cleaner__) { window.__ai_beforeunload_cleaner__ = setInterval(function() { window.onbeforeunload = null; }, 2000); } })();`,
    label: '屏蔽离开页面提示',
    enabled: true,
    builtin: true,
  },
  // ===== ChatGPT =====
  {
    id: 'builtin-chatgpt-download',
    domainPattern: '*.chatgpt.com',
    type: 'css',
    selector: '[class*="download-app"], [class*="app-cta"], [data-testid="mobile-app-banner"]',
    label: 'ChatGPT 下载应用提示',
    enabled: true,
    builtin: true,
  },
  // ===== Claude =====
  {
    id: 'builtin-claude-upgrade',
    domainPattern: '*.claude.ai',
    type: 'css',
    selector: '[class*="upgrade-banner"], [class*="subscription-banner"]',
    label: 'Claude 订阅升级横幅',
    enabled: true,
    builtin: true,
  },
  // ===== DeepSeek =====
  {
    id: 'builtin-deepseek-download',
    domainPattern: '*.deepseek.com',
    type: 'css',
    selector: '.ds-button--outlinedNeutral, [class*="_9579690"], [class*="download"], [class*="app-download"], [class*="app-banner"], [class*="qrcode"], a[href*="download"]',
    label: 'DeepSeek 下载按钮',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin-deepseek-download-js',
    domainPattern: '*.deepseek.com',
    type: 'js',
    selector: '',
    jsCode: `(function() {
      var buttons = document.querySelectorAll('.ds-button, [role="button"], button');
      buttons.forEach(function(btn) {
        var text = (btn.textContent || '').trim();
        if (text === '下载应用' || text === '下载DeepSeek' || text.indexOf('下载应用') >= 0) {
          var el = btn;
          for (var i = 0; i < 5; i++) {
            if (!el || el === document.body) break;
            el = el.parentElement;
            if (el && el.offsetHeight < 200) {
              el.style.setProperty('display', 'none', 'important');
              break;
            }
          }
          btn.style.setProperty('display', 'none', 'important');
        }
      });
      if (!window.__ai_deepseek_block_observer__) {
        window.__ai_deepseek_block_observer__ = true;
        var observer = new MutationObserver(function() {
          document.querySelectorAll('.ds-button, [role="button"], button').forEach(function(btn) {
            var text = (btn.textContent || '').trim();
            if (text === '下载应用' || text.indexOf('下载应用') >= 0) {
              var el = btn;
              for (var i = 0; i < 5; i++) {
                if (!el || el === document.body) break;
                el = el.parentElement;
                if (el && el.offsetHeight < 200) {
                  el.style.setProperty('display', 'none', 'important');
                  break;
                }
              }
              btn.style.setProperty('display', 'none', 'important');
            }
          });
        });
        observer.observe(document.body, { childList: true, subtree: true });
      }
    })();`,
    label: 'DeepSeek 下载按钮（JS 文本匹配）',
    enabled: true,
    builtin: true,
  },
  // ===== 豆包 =====
  {
    id: 'builtin-doubao-download',
    domainPattern: '*.doubao.com',
    type: 'css',
    selector: '[class*="download" i], [class*="app-download" i], [class*="app-banner" i], [class*="qrcode" i], a[href*="/download"], a[href*="/download/app"]',
    label: '豆包下载提示',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin-doubao-download-js',
    domainPattern: '*.doubao.com',
    type: 'js',
    selector: '',
    jsCode: `(function() {
      var keywords = ['下载豆包', '下载 App', '下载应用', '下载客户端', '扫码下载'];
      function hideIfMatch(el) {
        var text = (el.textContent || '').trim();
        if (text.length > 60) return false;
        for (var i = 0; i < keywords.length; i++) {
          if (text.indexOf(keywords[i]) >= 0) return true;
        }
        var imgs = el.querySelectorAll ? el.querySelectorAll('img[src*="qrcode"], img[src*="download"], canvas') : [];
        if (imgs.length > 0 && el.querySelectorAll('a[href*="/download"], a[href*="/download/app"]').length > 0) return true;
        return false;
      }
      function scan() {
        var candidates = document.querySelectorAll('[role="button"], button, a, div, span');
        candidates.forEach(function(el) {
          if (el.getAttribute('data-ai-blocked')) return;
          if (hideIfMatch(el)) {
            el.setAttribute('data-ai-blocked', '1');
            el.style.setProperty('display', 'none', 'important');
          }
        });
      }
      scan();
      if (!window.__ai_doubao_block_observer__) {
        window.__ai_doubao_block_observer__ = true;
        new MutationObserver(function() { scan(); }).observe(document.body, { childList: true, subtree: true });
      }
    })();`,
    label: '豆包下载提示（JS 文本匹配）',
    enabled: true,
    builtin: true,
  },
  // ===== Kimi（月之暗面） =====
  {
    id: 'builtin-kimi-download',
    domainPattern: '*.moonshot.cn',
    type: 'css',
    selector: '[class*="download" i], [class*="app-download" i], [class*="app-banner" i], [class*="qrcode" i], a[href*="/download/app"], a[href*="/download"], a[href*="extension/download"]',
    label: 'Kimi 下载提示',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin-kimi-download-js',
    domainPattern: '*.moonshot.cn',
    type: 'js',
    selector: '',
    jsCode: `(function() {
      var keywords = ['下载 Kimi', '下载App', '下载 App', '下载应用', '下载客户端', '扫码下载', '安装插件'];
      function hideIfMatch(el) {
        var text = (el.textContent || '').trim();
        if (text.length > 60) return false;
        for (var i = 0; i < keywords.length; i++) {
          if (text.indexOf(keywords[i]) >= 0) return true;
        }
        return false;
      }
      function scan() {
        var candidates = document.querySelectorAll('[role="button"], button, a, div, span');
        candidates.forEach(function(el) {
          if (el.getAttribute('data-ai-blocked')) return;
          if (hideIfMatch(el)) {
            el.setAttribute('data-ai-blocked', '1');
            el.style.setProperty('display', 'none', 'important');
          }
        });
      }
      scan();
      if (!window.__ai_kimi_block_observer__) {
        window.__ai_kimi_block_observer__ = true;
        new MutationObserver(function() { scan(); }).observe(document.body, { childList: true, subtree: true });
      }
    })();`,
    label: 'Kimi 下载提示（JS 文本匹配）',
    enabled: true,
    builtin: true,
  },
  // ===== 智谱清言 =====
  {
    id: 'builtin-chatglm-download',
    domainPattern: '*.chatglm.cn',
    type: 'css',
    selector: '[class*="download" i], [class*="app-banner" i], [class*="qrcode" i], a[href*="/download"], a[href*="/download/app"]',
    label: '智谱清言下载提示',
    enabled: false,
    builtin: true,
  },
  {
    id: 'builtin-chatglm-download-js',
    domainPattern: '*.chatglm.cn',
    type: 'js',
    selector: '',
    jsCode: `(function() {
      var keywords = ['下载智谱', '下载App', '下载 App', '下载应用', '扫码下载'];
      function hideIfMatch(el) {
        var text = (el.textContent || '').trim();
        if (text.length > 60) return false;
        for (var i = 0; i < keywords.length; i++) {
          if (text.indexOf(keywords[i]) >= 0) return true;
        }
        return false;
      }
      function scan() {
        document.querySelectorAll('[role="button"], button, a, div, span').forEach(function(el) {
          if (el.getAttribute('data-ai-blocked')) return;
          if (hideIfMatch(el)) {
            el.setAttribute('data-ai-blocked', '1');
            el.style.setProperty('display', 'none', 'important');
          }
        });
      }
      scan();
      if (!window.__ai_chatglm_block_observer__) {
        window.__ai_chatglm_block_observer__ = true;
        new MutationObserver(function() { scan(); }).observe(document.body, { childList: true, subtree: true });
      }
    })();`,
    label: '智谱清言下载提示（JS 文本匹配）',
    enabled: false,
    builtin: true,
  },
  // ===== Gemini =====
  {
    id: 'builtin-gemini-upgrade',
    domainPattern: '*.gemini.google.com',
    type: 'css',
    selector: '[class*="upgrade" i], [class*="advanced-banner" i], [class*="subscription-banner" i], [class*="try-advanced" i], [data-testid*="upgrade"]',
    label: 'Gemini 升级横幅',
    enabled: true,
    builtin: true,
  },
  // ===== 文心一言 =====
  {
    id: 'builtin-yiyan-download',
    domainPattern: '*.yiyan.baidu.com',
    type: 'css',
    selector: '[class*="download" i], [class*="app-download" i], [class*="app-banner" i], [class*="qrcode" i], a[href*="/download"], a[href*="/download/app"]',
    label: '文心一言下载提示',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin-yiyan-download-js',
    domainPattern: '*.yiyan.baidu.com',
    type: 'js',
    selector: '',
    jsCode: `(function() {
      var keywords = ['下载文心', '下载 App', '下载应用', '下载客户端', '扫码下载', '安装文心一言'];
      function hideIfMatch(el) {
        var text = (el.textContent || '').trim();
        if (text.length > 60) return false;
        for (var i = 0; i < keywords.length; i++) {
          if (text.indexOf(keywords[i]) >= 0) return true;
        }
        return false;
      }
      function scan() {
        document.querySelectorAll('[role="button"], button, a, div, span').forEach(function(el) {
          if (el.getAttribute('data-ai-blocked')) return;
          if (hideIfMatch(el)) {
            el.setAttribute('data-ai-blocked', '1');
            el.style.setProperty('display', 'none', 'important');
          }
        });
      }
      scan();
      if (!window.__ai_yiyan_block_observer__) {
        window.__ai_yiyan_block_observer__ = true;
        new MutationObserver(function() { scan(); }).observe(document.body, { childList: true, subtree: true });
      }
    })();`,
    label: '文心一言下载提示（JS 文本匹配）',
    enabled: true,
    builtin: true,
  },
  // ===== 小米 Mimo =====
  {
    id: 'builtin-mimo-redirect',
    domainPattern: '*.xiaomi.com',
    type: 'css',
    selector: '[class*="download" i], [class*="app-download" i], [class*="app-banner" i], [class*="qrcode" i], a[href*="/download"], a[href*="/download/app"]',
    label: '小米 Mimo 下载提示',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin-mimo-redirect-js',
    domainPattern: '*.xiaomi.com',
    type: 'js',
    selector: '',
    jsCode: `(function() {
      var keywords = ['下载 Mimo', '下载App', '下载 App', '下载应用', '扫码下载', '下载客户端'];
      function hideIfMatch(el) {
        var text = (el.textContent || '').trim();
        if (text.length > 60) return false;
        for (var i = 0; i < keywords.length; i++) {
          if (text.indexOf(keywords[i]) >= 0) return true;
        }
        return false;
      }
      function scan() {
        document.querySelectorAll('[role="button"], button, a, div, span').forEach(function(el) {
          if (el.getAttribute('data-ai-blocked')) return;
          if (hideIfMatch(el)) {
            el.setAttribute('data-ai-blocked', '1');
            el.style.setProperty('display', 'none', 'important');
          }
        });
      }
      scan();
      if (!window.__ai_mimo_block_observer__) {
        window.__ai_mimo_block_observer__ = true;
        new MutationObserver(function() { scan(); }).observe(document.body, { childList: true, subtree: true });
      }
    })();`,
    label: '小米 Mimo 下载提示（JS 文本匹配）',
    enabled: true,
    builtin: true,
  },
]

// =============================================================================
// Device Presets（第一个元素即默认预设）
// =============================================================================

/** 预置预设数据版本号（用于后续迁移） */
export const PRESETS_VERSION = 1

/** iPhone 15 Pro / Safari 移动端 UA */
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

/** Windows / Chrome 125 桌面端 UA */
const WIN_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

/** 预置设备预设（id 使用固定值便于幂等填充） */
export const PRESETS: DevicePreset[] = [
  {
    id: 'win-chrome-125',
    name: 'Windows / Chrome 125',
    userAgent: WIN_CHROME_UA,
    platform: 'desktop',
    viewport: { width: 1920, height: 1080 },
    devicePixelRatio: 1,
    navigatorPlatform: 'Win32',
    vendor: 'Google Inc.',
    maxTouchPoints: 0,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    brands: [
      { brand: 'Google Chrome', version: '125' },
      { brand: 'Chromium', version: '125' },
      { brand: 'Not.A/Brand', version: '24' },
    ],
    chPlatform: 'Windows',
    chPlatformVersion: '10.0.0',
    chMobile: false,
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
    builtin: true,
  },
  {
    id: 'mac-safari-17',
    name: 'macOS / Safari 17',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    platform: 'desktop',
    viewport: { width: 1680, height: 1050 },
    devicePixelRatio: 2,
    navigatorPlatform: 'MacIntel',
    vendor: 'Apple Computer, Inc.',
    maxTouchPoints: 0,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    brands: [],
    chPlatform: 'macOS',
    chPlatformVersion: '14.5.0',
    chMobile: false,
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
    builtin: true,
  },
  {
    id: 'iphone-15-pro-safari',
    name: 'iPhone 15 Pro / Safari',
    userAgent: IPHONE_UA,
    platform: 'mobile',
    viewport: IPHONE_VIEWPORT,
    devicePixelRatio: 3,
    navigatorPlatform: 'iPhone',
    vendor: 'Apple Computer, Inc.',
    maxTouchPoints: 5,
    hardwareConcurrency: 6,
    deviceMemory: 4,
    brands: [],
    chPlatform: 'iOS',
    chPlatformVersion: '17.5.0',
    chMobile: true,
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
    builtin: true,
  },
  {
    id: 'ipad-pro-safari',
    name: 'iPad Pro / Safari',
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    platform: 'mobile',
    viewport: { width: 1024, height: 1366 },
    devicePixelRatio: 2,
    navigatorPlatform: 'iPad',
    vendor: 'Apple Computer, Inc.',
    maxTouchPoints: 5,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    brands: [],
    chPlatform: 'iOS',
    chPlatformVersion: '17.5.0',
    chMobile: true,
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
    builtin: true,
  },
  {
    id: 'pixel-8-chrome',
    name: 'Pixel 8 Pro / Chrome',
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
    platform: 'mobile',
    viewport: { width: 412, height: 892 },
    devicePixelRatio: 3.5,
    navigatorPlatform: 'Linux armv8l',
    vendor: 'Google Inc.',
    maxTouchPoints: 5,
    hardwareConcurrency: 8,
    deviceMemory: 12,
    brands: [
      { brand: 'Google Chrome', version: '125' },
      { brand: 'Chromium', version: '125' },
      { brand: 'Not.A/Brand', version: '24' },
    ],
    chPlatform: 'Android',
    chPlatformVersion: '14.0.0',
    chMobile: true,
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
    builtin: true,
  },
]

// =============================================================================
// Prompt Templates（第一个元素即默认模板）
// =============================================================================

/** 首次启动填充的通用预置模板（不含 id/createdAt/updatedAt，由 save 时补全） */
export const PROMPTS: Array<Omit<PromptTemplate, 'id' | 'createdAt' | 'updatedAt'>> = [
  { title: '总结全文', content: '请用简洁的语言总结以下内容的要点，分条列出：\n\n{{body}}', category: '通用' },
  { title: '翻译为英文', content: '请将以下内容翻译为自然流畅的英文：\n\n{{body}}', category: '通用' },
  { title: '扩写细节', content: '请在保持原意的基础上，扩写以下内容，补充更多细节与示例：\n\n{{body}}', category: '通用' },
  { title: '润色优化', content: '请润色以下文字，使其更专业、流畅，并保留原意：\n\n{{body}}', category: '通用' },
  { title: '解释代码', content: '请逐行解释以下代码的作用与实现思路：\n\n{{body}}', category: '开发' },
]

// =============================================================================
// AI Platforms 导出（单一数据源）
// =============================================================================

/** 内置 AI 平台列表（从 presets/ai-platforms.ts 重导出） */
export { AI_PLATFORMS }

// =============================================================================
// Profile 默认值生成
// =============================================================================

/**
 * Profile 创建参数（用于 ensureDefaultProfiles）
 */
export interface DefaultProfileParams {
  name: string
  isBuiltIn: boolean
  devicePreset: string
  userAgent: string
  platform: 'mobile' | 'desktop'
  viewport: { width: number; height: number }
  devicePixelRatio: number
  language: string
  timezone: string
  isAIPlatform: boolean
  aiPlatformUrl: string
  aiPlatformId: string
  aiPlatformRegion: 'cn' | 'global'
  aiDesktopPreset: string
  aiMobilePreset: string
  aiThemeColor: string
  width: number
  height: number
  order: number
  fingerprint: {
    seed: number
    canvas: string
    webgl: string
    audio: string
    fonts: string
    webrtc: string
  }
}

/**
 * 生成默认 AI 平台 Profile 列表。
 * 基于 AI_PLATFORMS 和 iPhone 15 Pro 视口尺寸生成 9 个 Profile 参数。
 *
 * @returns Profile 创建参数数组（可直接传给 profileStore.create）
 */
export function getDefaultProfileParams(): DefaultProfileParams[] {
  return AI_PLATFORMS.map((platform, index) => ({
    name: platform.name,
    isBuiltIn: platform.id === 'deepseek',
    devicePreset: platform.defaultMobilePreset,
    userAgent: platform.defaultUA,
    platform: 'mobile' as const,
    viewport: {
      width: IPHONE_VIEWPORT.width,
      height: IPHONE_VIEWPORT.height,
    },
    devicePixelRatio: 3, // iPhone 15 Pro 固定 3x
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
    isAIPlatform: true,
    aiPlatformUrl: platform.url,
    aiPlatformId: platform.id,
    aiPlatformRegion: platform.region,
    aiDesktopPreset: platform.defaultDesktopPreset,
    aiMobilePreset: platform.defaultMobilePreset,
    aiThemeColor: platform.themeColor,
    width: IPHONE_VIEWPORT.width,
    height: IPHONE_VIEWPORT.height,
    order: index,
    fingerprint: {
      seed: Math.floor(Math.random() * 0xffffffff),
      canvas: 'noise',
      webgl: 'noise',
      audio: 'noise',
      fonts: 'noise',
      webrtc: 'real',
    },
  }))
}

// =============================================================================
// VoiceConfig（语音配置默认值）
// =============================================================================

/** 语音配置默认值 */
export const VOICE_CONFIG: VoiceConfig = {
  confirmMode: 'auto',
  inputMethod: 'layered',
  enterToSend: false,
  sttMode: 'ai',
  aiProvider: '',
  language: 'zh',
  localExePath: '',
  localArgs: '',
  inputDeviceId: '',
  inputDeviceList: [],
  ttsMode: 'disable',
  ttsProvider: '',
}

// =============================================================================
// Profile 默认值（创建新 Profile 时使用）
// =============================================================================

/** Windows Chrome 125 默认 UA（与 presets/devices.ts 中 win-chrome-125 预设一致） */
const WINDOWS_CHROME_125_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

/**
 * 创建默认 Profile 的参数模板
 * 指纹种子每次随机，保证 Profile 间指纹差异。
 */
export function createDefaultProfileParams(): Omit<Profile, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: '未命名 Profile',
    devicePreset: 'win-chrome-125',
    userAgent: WINDOWS_CHROME_125_UA,
    platform: 'desktop',
    viewport: { width: 1920, height: 1080 },
    devicePixelRatio: 1,
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
    proxy: '',
    fingerprint: {
      seed: Math.floor(Math.random() * 0xffffffff),
      canvas: 'noise',
      webgl: 'noise',
      audio: 'noise',
      fonts: 'noise',
      webrtc: 'real',
    },
    // 默认窗口尺寸：类似旧版 QQ 的窄长条形
    width: 320,
    height: 720,
    alwaysOnTop: false,
    order: 0,
    // 浏览器独立窗口主页 URL（留空时回退到 aiPlatformUrl）
    browserHomePage: '',
  }
}
