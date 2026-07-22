// electron/fingerprint/engine.ts — 指纹引擎
//
// 根据 Profile 配置生成 preload 注入脚本（IIFE 字符串），覆盖
// Canvas / WebGL / AudioContext / Navigator / ClientHints / Font / WebRTC 指纹，
// 让每个 Profile 看起来像真实不同的设备。
//
// 核心原则：一致性（UA 声称 iPhone 时 platform/vendor/maxTouchPoints 必须匹配，
// 由设备预设保证）+ 确定性（同一 Profile 每次启动指纹值相同，由 seed + mulberry32 PRNG 保证）。

import type { Profile, DevicePreset, FingerprintMode } from '../shared/types.js'
import { getPreset } from '../store/preset-store.js'

// ============================================================================
// 常量池
// ============================================================================

/** 常见 WebGL UNMASKED_VENDOR 字符串池（noise 模式下基于 PRNG 选取） */
const WEBGL_VENDORS = [
  'Google Inc. (Intel)',
  'Google Inc. (NVIDIA)',
  'Google Inc. (AMD)',
]

/** 常见 WebGL UNMASKED_RENDERER 字符串池 */
const WEBGL_RENDERERS = [
  'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.5)',
  'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060, OpenGL 4.5)',
  'ANGLE (AMD, AMD Radeon RX 580, OpenGL 4.5)',
]

/** 字体白名单：只暴露常见系统字体，其余一律返回 false */
const FONT_WHITELIST = [
  'Arial',
  'Helvetica',
  'Times New Roman',
  'Courier New',
  'Georgia',
  'Verdana',
  'sans-serif',
  'serif',
  'monospace',
]

/** 1x1 透明 PNG dataURL，Canvas block 模式返回此值 */
const BLANK_PNG_DATAURL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

/** Canvas 噪声注入间隔（每 N 个像素改 1 个） */
const CANVAS_NOISE_INTERVAL = 100
/** WebGL UNMASKED_VENDOR_WEBGL getParameter 参数常量 */
const UNMASKED_VENDOR_WEBGL = 0x9245
/** WebGL UNMASKED_RENDERER_WEBGL getParameter 参数常量 */
const UNMASKED_RENDERER_WEBGL = 0x9246

// ============================================================================
// 注入上下文：所有需要在生成脚本中使用的配置值（已 JSON 安全化）
// ============================================================================

interface ScriptContext {
  /** 指纹随机种子 */
  seed: number
  /** 最终使用的 User-Agent（profile.userAgent 优先，否则用预设） */
  userAgent: string
  /** 设备预设 */
  preset: DevicePreset
  /** UA 完整版本号（用于 userAgentData.uaFullVersion） */
  uaFullVersion: string
  /** CPU 架构（桌面=x86 / 移动=空） */
  architecture: string
  /** 位数（桌面=64 / 移动=空） */
  bitness: string
}

// ============================================================================
// 指纹引擎
// ============================================================================

export class FingerprintEngine {
  /**
   * 根据 Profile 生成完整的指纹覆盖 preload 脚本字符串。
   * 返回一个 IIFE，应在页面所有 JS 之前执行。
   */
  generateScript(profile: Profile): string {
    // 1. 读取设备预设（profile.devicePreset）
    const preset = getPreset(profile.devicePreset)
    if (!preset) {
      // 找不到预设：返回最小空脚本，避免崩溃，不覆盖任何指纹
      return ';(function(){\n"use strict"\n// 无设备预设，跳过指纹注入\n})();'
    }

    // 2. 构建注入上下文
    const ctx = this.buildContext(profile, preset)

    // 3. 收集各维度覆盖代码片段
    const fp = profile.fingerprint
    const parts: string[] = []

    parts.push(this.buildHeader(ctx))
    if (fp.canvas !== 'real') parts.push(this.buildCanvas(fp.canvas))
    if (fp.webgl !== 'real') parts.push(this.buildWebGL(fp.webgl))
    if (fp.audio !== 'real') parts.push(this.buildAudio(fp.audio))
    if (fp.fonts !== 'real') parts.push(this.buildFonts(fp.fonts))
    if (fp.webrtc === 'block') parts.push(this.buildWebRTC())
    parts.push(this.buildNavigator(ctx))
    parts.push(this.buildViewport(ctx))
    parts.push(this.buildTimezone(ctx))
    // 仅 Chrome 类预设（brands 非空）覆盖 userAgentData，Safari 类保持原生（无此 API）更一致
    if (preset.brands.length > 0) parts.push(this.buildClientHints(ctx))

    // 4. 用 IIFE 包裹返回
    return ';(function(){\n"use strict"\n' + parts.join('\n\n') + '\n})();'
  }

  // --------------------------------------------------------------------------
  // 上下文构建
  // --------------------------------------------------------------------------

  /** 构建注入上下文：解析 UA 主版本、推导 architecture/bitness */
  private buildContext(profile: Profile, preset: DevicePreset): ScriptContext {
    const userAgent = profile.userAgent || preset.userAgent
    const chromeBrand = preset.brands.find((b) => b.brand === 'Google Chrome')
    const majorVersion = chromeBrand?.version || this.extractMajorVersion(userAgent)
    // uaFullVersion：Chrome 125 对应真实构建号 125.0.6422.142，其余用主版本 + 通用 build 号
    const uaFullVersion = majorVersion === '125' ? '125.0.6422.142' : `${majorVersion}.0.0.0`
    const isMobile = preset.platform === 'mobile'
    return {
      seed: profile.fingerprint.seed,
      userAgent,
      preset,
      uaFullVersion,
      architecture: isMobile ? '' : 'x86',
      bitness: isMobile ? '' : '64',
    }
  }

  /** 从 UA 字符串中提取 Chrome/Version 主版本号 */
  private extractMajorVersion(ua: string): string {
    const m = ua.match(/(?:Chrome|Version)\/(\d+)/)
    return m ? m[1] : '125'
  }

  // --------------------------------------------------------------------------
  // 头部：PRNG 定义
  // --------------------------------------------------------------------------

  private buildHeader(ctx: ScriptContext): string {
    return `// ===== 指纹引擎：基于种子 ${ctx.seed} 注入 =====
var __seed = ${ctx.seed}
// mulberry32 PRNG：保证同一 Profile 每次启动生成相同指纹值
function __mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0
    var t = Math.imul(seed ^ seed >>> 15, 1 | seed)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}
var __rng = __mulberry32(__seed)
// 基于索引从数组确定性选取
function __pick(arr) { return arr[Math.floor(__rng() * arr.length)] }`
  }

  // --------------------------------------------------------------------------
  // Canvas 指纹
  // --------------------------------------------------------------------------

  private buildCanvas(mode: FingerprintMode): string {
    return mode === 'block' ? this.buildCanvasBlock() : this.buildCanvasNoise()
  }

  private buildCanvasNoise(): string {
    return `// ===== Canvas 指纹：noise 模式（向像素注入微噪声） =====
var __origToDataURL = HTMLCanvasElement.prototype.toDataURL
var __origToBlob = HTMLCanvasElement.prototype.toBlob
var __origGetImageData = CanvasRenderingContext2D.prototype.getImageData
// 每 100 个像素改 1 个，每像素 RGB ±1 偏移，避免视觉影响但改变哈希
function __injectCanvasNoise(imageData) {
  var data = imageData.data
  for (var i = 0; i < data.length; i += 4) {
    if ((i / 4) % ${CANVAS_NOISE_INTERVAL} === 0) {
      data[i]     = Math.max(0, Math.min(255, data[i]     + (__rng() < 0.5 ? -1 : 1)))
      data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + (__rng() < 0.5 ? -1 : 1)))
      data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + (__rng() < 0.5 ? -1 : 1)))
    }
  }
  return imageData
}
HTMLCanvasElement.prototype.toDataURL = function() {
  try {
    var ctx = this.getContext('2d')
    if (ctx) {
      var w = this.width, h = this.height
      if (w > 0 && h > 0) {
        var img = __origGetImageData.call(ctx, 0, 0, w, h)
        __injectCanvasNoise(img)
        ctx.putImageData(img, 0, 0)
      }
    }
  } catch (e) {}
  return __origToDataURL.apply(this, arguments)
}
HTMLCanvasElement.prototype.toBlob = function(callback) {
  try {
    var ctx = this.getContext('2d')
    if (ctx) {
      var w = this.width, h = this.height
      if (w > 0 && h > 0) {
        var img = __origGetImageData.call(ctx, 0, 0, w, h)
        __injectCanvasNoise(img)
        ctx.putImageData(img, 0, 0)
      }
    }
  } catch (e) {}
  return __origToBlob.apply(this, arguments)
}
CanvasRenderingContext2D.prototype.getImageData = function() {
  var img = __origGetImageData.apply(this, arguments)
  try { __injectCanvasNoise(img) } catch (e) {}
  return img
}`
  }

  private buildCanvasBlock(): string {
    return `// ===== Canvas 指纹：block 模式（返回空白图） =====
var __origGetImageData = CanvasRenderingContext2D.prototype.getImageData
var __blankPng = ${JSON.stringify(BLANK_PNG_DATAURL)}
HTMLCanvasElement.prototype.toDataURL = function() { return __blankPng }
HTMLCanvasElement.prototype.toBlob = function(callback) {
  try {
    var bytes = atob(__blankPng.split(',')[1])
    var arr = new Uint8Array(bytes.length)
    for (var i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
    var blob = new Blob([arr], { type: 'image/png' })
    if (typeof callback === 'function') callback(blob)
  } catch (e) {
    if (typeof callback === 'function') callback(new Blob())
  }
  return undefined
}
CanvasRenderingContext2D.prototype.getImageData = function(sx, sy, sw, sh) {
  var img = __origGetImageData.apply(this, arguments)
  for (var i = 0; i < img.data.length; i++) img.data[i] = 0
  return img
}`
  }

  // --------------------------------------------------------------------------
  // WebGL 指纹
  // --------------------------------------------------------------------------

  private buildWebGL(mode: FingerprintMode): string {
    return mode === 'block' ? this.buildWebGLBlock() : this.buildWebGLNoise()
  }

  private buildWebGLNoise(): string {
    const vendors = JSON.stringify(WEBGL_VENDORS)
    const renderers = JSON.stringify(WEBGL_RENDERERS)
    return `// ===== WebGL 指纹：noise 模式（基于 PRNG 从池中选取 vendor/renderer） =====
var __webglVendors = ${vendors}
var __webglRenderers = ${renderers}
var __webglVendor = __pick(__webglVendors)
var __webglRenderer = __pick(__webglRenderers)
var __origGetParameter = WebGLRenderingContext.prototype.getParameter
WebGLRenderingContext.prototype.getParameter = function(param) {
  if (param === ${UNMASKED_VENDOR_WEBGL}) return __webglVendor      // UNMASKED_VENDOR_WEBGL
  if (param === ${UNMASKED_RENDERER_WEBGL}) return __webglRenderer    // UNMASKED_RENDERER_WEBGL
  return __origGetParameter.call(this, param)
}
if (typeof WebGL2RenderingContext !== 'undefined') {
  var __origGetParameter2 = WebGL2RenderingContext.prototype.getParameter
  WebGL2RenderingContext.prototype.getParameter = function(param) {
    if (param === ${UNMASKED_VENDOR_WEBGL}) return __webglVendor
    if (param === ${UNMASKED_RENDERER_WEBGL}) return __webglRenderer
    return __origGetParameter2.call(this, param)
  }
}`
  }

  private buildWebGLBlock(): string {
    return `// ===== WebGL 指纹：block 模式（vendor/renderer 返回空） =====
var __origGetParameter = WebGLRenderingContext.prototype.getParameter
WebGLRenderingContext.prototype.getParameter = function(param) {
  if (param === ${UNMASKED_VENDOR_WEBGL} || param === ${UNMASKED_RENDERER_WEBGL}) return ''
  return __origGetParameter.call(this, param)
}
if (typeof WebGL2RenderingContext !== 'undefined') {
  var __origGetParameter2 = WebGL2RenderingContext.prototype.getParameter
  WebGL2RenderingContext.prototype.getParameter = function(param) {
    if (param === ${UNMASKED_VENDOR_WEBGL} || param === ${UNMASKED_RENDERER_WEBGL}) return ''
    return __origGetParameter2.call(this, param)
  }
}`
  }

  // --------------------------------------------------------------------------
  // AudioContext 指纹
  // --------------------------------------------------------------------------

  private buildAudio(mode: FingerprintMode): string {
    return mode === 'block' ? this.buildAudioBlock() : this.buildAudioNoise()
  }

  private buildAudioNoise(): string {
    return `// ===== AudioContext 指纹：noise 模式（注入微噪声） =====
// 覆盖 getFloatFrequencyData：频率数据 ±0.0001 偏移
var __origGetFloatFreq = AnalyserNode.prototype.getFloatFrequencyData
AnalyserNode.prototype.getFloatFrequencyData = function(array) {
  __origGetFloatFreq.apply(this, arguments)
  for (var i = 0; i < array.length; i++) {
    array[i] += (__rng() - 0.5) * 0.0002
  }
}
// 覆盖 getChannelData：同时覆盖 OfflineAudioContext 渲染产物（共享 AudioBuffer 原型）
var __origGetChannelData = AudioBuffer.prototype.getChannelData
AudioBuffer.prototype.getChannelData = function(channel) {
  var data = __origGetChannelData.call(this, channel)
  // 每 100 个采样注入微噪声，避免影响音质
  for (var i = 0; i < data.length; i += 100) {
    data[i] += (__rng() - 0.5) * 0.0002
  }
  return data
}`
  }

  private buildAudioBlock(): string {
    return `// ===== AudioContext 指纹：block 模式（频率填 -100dB，采样置 0） =====
AnalyserNode.prototype.getFloatFrequencyData = function(array) {
  for (var i = 0; i < array.length; i++) array[i] = -100
}
var __origGetChannelData = AudioBuffer.prototype.getChannelData
AudioBuffer.prototype.getChannelData = function(channel) {
  var data = __origGetChannelData.call(this, channel)
  for (var i = 0; i < data.length; i++) data[i] = 0
  return data
}`
  }

  // --------------------------------------------------------------------------
  // 字体指纹
  // --------------------------------------------------------------------------

  private buildFonts(mode: FingerprintMode): string {
    const whitelist = JSON.stringify(FONT_WHITELIST)
    if (mode === 'block') {
      return `// ===== 字体指纹：block 模式（全部隐藏，返回 false） =====
if (document.fonts && typeof document.fonts.check === 'function') {
  document.fonts.check = function() { return false }
}`
    }
    return `// ===== 字体指纹：noise 模式（白名单制，只暴露常见系统字体） =====
var __fontWhitelist = ${whitelist}
if (document.fonts && typeof document.fonts.check === 'function') {
  var __origFontsCheck = document.fonts.check
  document.fonts.check = function(font, text) {
    var lowerFont = (font || '').toLowerCase()
    for (var i = 0; i < __fontWhitelist.length; i++) {
      if (lowerFont.indexOf(__fontWhitelist[i].toLowerCase()) !== -1) return true
    }
    return false
  }
}`
  }

  // --------------------------------------------------------------------------
  // WebRTC
  // --------------------------------------------------------------------------

  private buildWebRTC(): string {
    return `// ===== WebRTC：block 模式（清空 iceServers 防真实 IP 泄漏） =====
var __origRTC = window.RTCPeerConnection
if (__origRTC) {
  function __patchedRTC(config, constraints) {
    if (config && config.iceServers) {
      config.iceServers = []
    }
    return new __origRTC(config, constraints)
  }
  __patchedRTC.prototype = __origRTC.prototype
  window.RTCPeerConnection = __patchedRTC
}`
  }

  // --------------------------------------------------------------------------
  // Navigator 覆盖（一致性关键）
  // --------------------------------------------------------------------------

  private buildNavigator(ctx: ScriptContext): string {
    const ua = JSON.stringify(ctx.userAgent)
    const platform = JSON.stringify(ctx.preset.navigatorPlatform)
    const vendor = JSON.stringify(ctx.preset.vendor)
    const maxTouch = ctx.preset.maxTouchPoints
    const hc = ctx.preset.hardwareConcurrency
    const dm = ctx.preset.deviceMemory
    const lang = JSON.stringify(ctx.preset.language)
    const langs = JSON.stringify([ctx.preset.language, 'en-US', 'en'])
    return `// ===== Navigator 覆盖（一致性关键，读取设备预设注入） =====
// __defProp 通用属性定义器在 Viewport 段定义（函数声明提升，全 IIFE 作用域可用）
__defProp(navigator, 'userAgent', ${ua})
__defProp(navigator, 'platform', ${platform})
__defProp(navigator, 'vendor', ${vendor})
__defProp(navigator, 'maxTouchPoints', ${maxTouch})
__defProp(navigator, 'hardwareConcurrency', ${hc})
__defProp(navigator, 'deviceMemory', ${dm})
__defProp(navigator, 'webdriver', false)
__defProp(navigator, 'language', ${lang})
__defProp(navigator, 'languages', ${langs})`
  }

  // --------------------------------------------------------------------------
  // Client Hints（userAgentData）
  // --------------------------------------------------------------------------

  private buildClientHints(ctx: ScriptContext): string {
    const brands = JSON.stringify(ctx.preset.brands)
    const chMobile = ctx.preset.chMobile
    const chPlatform = JSON.stringify(ctx.preset.chPlatform)
    const chPlatformVersion = JSON.stringify(ctx.preset.chPlatformVersion)
    const uaFullVersion = JSON.stringify(ctx.uaFullVersion)
    const architecture = JSON.stringify(ctx.architecture)
    const bitness = JSON.stringify(ctx.bitness)
    return `// ===== Client Hints（navigator.userAgentData 覆盖） =====
try {
  var __uaBrands = ${brands}
  var __uaFullVersion = ${uaFullVersion}
  var __uaData = {
    brands: __uaBrands,
    mobile: ${chMobile},
    platform: ${chPlatform},
    getHighEntropyValues: function(hints) {
      var all = {
        architecture: ${architecture},
        bitness: ${bitness},
        fullVersionList: __uaBrands,
        mobile: ${chMobile},
        model: '',
        platform: ${chPlatform},
        platformVersion: ${chPlatformVersion},
        uaFullVersion: __uaFullVersion
      }
      if (!hints || !hints.length) return Promise.resolve(all)
      // 按 hints 过滤返回字段（贴近真实 Chrome 行为）
      var filtered = {}
      for (var i = 0; i < hints.length; i++) {
        if (Object.prototype.hasOwnProperty.call(all, hints[i])) {
          filtered[hints[i]] = all[hints[i]]
        }
      }
      return Promise.resolve(filtered)
    }
  }
  Object.defineProperty(navigator, 'userAgentData', {
    get: function() { return __uaData },
    configurable: true,
  })
} catch (e) {}`
  }

  // --------------------------------------------------------------------------
  // Viewport / Screen 覆盖
  // --------------------------------------------------------------------------

  private buildViewport(ctx: ScriptContext): string {
    const w = ctx.preset.viewport.width
    const h = ctx.preset.viewport.height
    const dpr = ctx.preset.devicePixelRatio
    return `// ===== Viewport / Screen 覆盖（按设备预设注入尺寸 + DPR） =====
var __vpW = ${w}, __vpH = ${h}, __dpr = ${dpr}
function __defProp(obj, prop, value) {
  try {
    Object.defineProperty(obj, prop, { get: (function(v){ return function(){ return v } })(value), configurable: true })
  } catch (e) {}
}
__defProp(screen, 'width', __vpW)
__defProp(screen, 'height', __vpH)
__defProp(screen, 'availWidth', __vpW)
__defProp(screen, 'availHeight', __vpH)
__defProp(screen, 'availLeft', 0)
__defProp(screen, 'availTop', 0)
__defProp(screen, 'colorDepth', 24)
__defProp(screen, 'pixelDepth', 24)
__defProp(window, 'innerWidth', __vpW)
__defProp(window, 'innerHeight', __vpH)
__defProp(window, 'outerWidth', __vpW)
__defProp(window, 'outerHeight', __vpH)
__defProp(window, 'devicePixelRatio', __dpr)
__defProp(window, 'screenX', 0)
__defProp(window, 'screenY', 0)`
  }

  // --------------------------------------------------------------------------
  // 时区覆盖
  // --------------------------------------------------------------------------

  /** 计算目标时区相对 UTC 的偏移分钟数（语义同 Date.prototype.getTimezoneOffset：东区为负） */
  private timezoneOffsetMinutes(tz: string): number {
    try {
      const now = new Date()
      const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
      const parts = fmt.formatToParts(now)
      const tzPart = parts.find((p) => p.type === 'timeZoneName')
      // tzPart.value 形如 "GMT+8" / "GMT-5:30"
      const m = tzPart?.value?.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/)
      if (!m) return new Date().getTimezoneOffset()
      const sign = m[1] === '-' ? -1 : 1
      const hours = parseInt(m[2], 10)
      const mins = m[3] ? parseInt(m[3], 10) : 0
      // shortOffset "GMT+8" 表示 local=UTC+8（东区为正）；
      // getTimezoneOffset 语义为 UTC-local（东区为负），故取反
      return -(sign * (hours * 60 + mins))
    } catch {
      return new Date().getTimezoneOffset()
    }
  }

  private buildTimezone(ctx: ScriptContext): string {
    const tz = JSON.stringify(ctx.preset.timezone)
    const offset = this.timezoneOffsetMinutes(ctx.preset.timezone)
    return `// ===== 时区覆盖（Intl.DateTimeFormat + Date.getTimezoneOffset） =====
var __tzName = ${tz}
var __tzOffset = ${offset}  // 分钟，东区为负（如 Asia/Shanghai = -480）
try {
  var __origGetTimezoneOffset = Date.prototype.getTimezoneOffset
  Date.prototype.getTimezoneOffset = function() { return __tzOffset }
} catch (e) {}
try {
  var __OrigDateTimeFormat = Intl.DateTimeFormat
  function __PatchedDateTimeFormat(locales, options) {
    var opts = options ? Object.assign({}, options) : {}
    if (!opts.timeZone) opts.timeZone = __tzName
    return new __OrigDateTimeFormat(locales, opts)
  }
  __PatchedDateTimeFormat.prototype = __OrigDateTimeFormat.prototype
  __PatchedDateTimeFormat.supportedLocalesOf = function() { return __OrigDateTimeFormat.supportedLocalesOf.apply(__OrigDateTimeFormat, arguments) }
  Intl.DateTimeFormat = __PatchedDateTimeFormat
} catch (e) {}`
  }
}
