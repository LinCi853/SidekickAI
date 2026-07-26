// electron/webview-preload.ts — webview 访客页 preload 脚本
//
// 在页面脚本执行前覆盖关键反检测属性，防止 DeepSeek 等网站
// 通过 navigator.webdriver / window.chrome / 插件等特征识别 Electron/WebView 环境。
//
// 不暴露任何 Electron/Node.js API，仅做属性覆盖。
// contextIsolation 隔离保证 Node 能力不泄露到页面。

// ===== 核心反检测：navigator.webdriver =====
// Chromium 在自动化/WebView 环境下会将此属性设为 true，
// 这是 DeepSeek 等网站检测非浏览器环境的首要信号。
try {
  Object.defineProperty(navigator, 'webdriver', {
    get: () => false,
    configurable: true,
  })
} catch {}

// ===== window.chrome 补全 =====
// Electron 中 window.chrome 可能缺失或不完整，真实 Chrome 浏览器存在
// chrome.runtime / chrome.csi / chrome.loadTimes 等属性，缺失会被检测。
try {
  const w = window as any
  if (!w.chrome) {
    Object.defineProperty(w, 'chrome', {
      value: {},
      writable: true,
      configurable: true,
      enumerable: true,
    })
  }
  const chrome = w.chrome
  if (!chrome.runtime) {
    chrome.runtime = {
      OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
      OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
      PlatformArch: { ARM: 'arm', ARM64: 'arm64', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
      PlatformNaclArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
      PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
      RequestUpdateCheckStatus: { THROTTLED: 'throttled', NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available' },
      connect: () => ({ disconnect() {}, onMessage: { addListener() {}, removeListener() {} }, onDisconnect: { addListener() {}, removeListener() {} }, postMessage() {} }),
      sendMessage: (_msg: unknown, _cb?: unknown) => { if (typeof _cb === 'function') _cb() },
      getManifest: () => ({ version: '0.0.0', name: '', description: '' }),
      id: undefined,
      getURL: (p: string) => `chrome-extension://invalid/${p}`,
      getPlatformInfo: (cb: Function) => { if (cb) cb({ os: 'win', arch: 'x86-64', nacl_arch: 'x86-64' }) },
    }
  }
  if (!chrome.csi) {
    chrome.csi = () => ({ startt: Date.now(), onloadT: Date.now(), pageT: 0, tran: 15 })
  }
  if (!chrome.loadTimes) {
    chrome.loadTimes = () => ({
      commitLoadTime: Date.now() / 1000,
      connectionInfo: 'h2',
      finishDocumentLoadTime: Date.now() / 1000,
      finishLoadTime: Date.now() / 1000,
      firstPaintAfterLoadTime: 0,
      firstPaintTime: Date.now() / 1000,
      navigationType: 'Other',
      npnNegotiatedProtocol: 'h2',
      requestTime: 0,
      startLoadTime: Date.now() / 1000,
      wasAlternateProtocolAvailable: false,
      wasFetchedViaSpdy: true,
      wasNpnNegotiated: true,
    })
  }
} catch {}

// ===== 插件列表伪装 =====
// Electron 中 navigator.plugins 为空数组，真实 Chrome 至少有内置 PDF 插件。
// 空插件列表是自动化检测的常见信号。
try {
  const makePlugin = (name: string, filename: string, description: string) => ({
    name, filename, description, length: 0,
    item: () => null, namedItem: () => null,
  })
  const plugins = [
    makePlugin('Chrome PDF Plugin', 'internal-pdf-viewer', 'Portable Document Format'),
    makePlugin('Chrome PDF Viewer', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', ''),
    makePlugin('Native Client', 'internal-nacl-plugin', ''),
  ]
  Object.setPrototypeOf(plugins, PluginArray.prototype)
  Object.defineProperty(navigator, 'plugins', { get: () => plugins, configurable: true })

  const mimeTypes = [
    { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: plugins[0] },
    { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: plugins[0] },
  ]
  Object.setPrototypeOf(mimeTypes, MimeTypeArray.prototype)
  Object.defineProperty(navigator, 'mimeTypes', { get: () => mimeTypes, configurable: true })
} catch {}

// ===== 语言一致性 =====
try {
  if (!navigator.languages || navigator.languages.length === 0) {
    Object.defineProperty(navigator, 'languages', {
      get: () => ['zh-CN', 'zh', 'en-US', 'en'],
      configurable: true,
    })
  }
} catch {}

// ===== 防御性清理可能泄露的 Electron 全局变量 =====
// contextIsolation:true 通常已隔离，但做一层兜底。
try {
  const leakKeys = ['__electron', '__electronBinding', 'Buffer', 'process', 'require', 'setImmediate', 'clearImmediate', 'global']
  for (const key of leakKeys) {
    try {
      if (key in window && (window as any)[key] !== undefined) {
        Object.defineProperty(window, key, { get: () => undefined, configurable: true })
      }
    } catch {}
  }
} catch {}

// ===== 隐藏 frameElement 为 WEBVIEW 的特征 =====
// 同域情况下 frameElement 可见，tagName 为 WEBVIEW 会暴露嵌入环境。
try {
  const w = window as any
  if (w.frameElement && w.frameElement.tagName === 'WEBVIEW') {
    Object.defineProperty(w.frameElement, 'tagName', { get: () => 'IFRAME' })
    Object.defineProperty(w.frameElement, 'nodeName', { get: () => 'IFRAME' })
  }
} catch {}
