// electron/platform/window/session.ts — Profile 会话准备（UA / 代理 / Client Hints）
//
// 从 window/manager.ts 拆出的 session 级设置：
//   - Client Hints 计算（预设品牌优先，否则从 UA 推导）
//   - setupSession：单页架构嵌入式 webview 使用的主窗口 session
//   - setupBrowserSession：浏览器窗口使用的独立 session（复制 Cookie + 桌面 UA + region 代理）
//
// 与窗口创建分离：这里只操作 session，不创建 BrowserWindow。

import { session, type Session } from 'electron'
import type { Profile } from '../../shared/types.js'
import { browserPorts } from '../browser-port.js'
import { applyProxyToSession, applyRegionBasedProxy } from '../../store/proxy-helper.js'

/** Client Hints 头配置（供 webRequest 拦截器注入） */
export interface ClientHints {
  /** Sec-CH-UA 品牌列表，如 `"Google Chrome";v="125", "Chromium";v="125"` */
  secChUa: string
  /** Sec-CH-UA-Mobile，`?0` 桌面 / `?1` 移动 */
  secChUaMobile: string
  /** Sec-CH-UA-Platform，如 `"Windows"` */
  secChUaPlatform: string
}

/** Client Hints 缓存：session key -> 当前配置（运行时可变，供拦截器读取） */
export type ClientHintsRegistry = Map<string, ClientHints>

/**
 * 安装 Client Hints 请求头拦截器。
 *
 * Safari 类预设（brands 为空，secChUa 为空字符串）不发送任何 Sec-CH-UA-* 头，
 * 真实 Safari 也不发这些头。若强行注入 Mobile/Platform 而无 Sec-CH-UA 主头，
 * 服务端（如 DeepSeek）会检测到客户端不一致并跳回首页/登录。
 */
export function applyClientHintsInterceptor(
  ses: Session,
  key: string,
  clientHints: ClientHintsRegistry,
): void {
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const h = clientHints.get(key)
    if (h && h.secChUa) {
      details.requestHeaders['Sec-CH-UA'] = h.secChUa
      details.requestHeaders['Sec-CH-UA-Mobile'] = h.secChUaMobile
      details.requestHeaders['Sec-CH-UA-Platform'] = h.secChUaPlatform
    } else if (h && !h.secChUa) {
      delete details.requestHeaders['Sec-CH-UA']
      delete details.requestHeaders['Sec-CH-UA-Mobile']
      delete details.requestHeaders['Sec-CH-UA-Platform']
      delete details.requestHeaders['Sec-CH-UA-Full-Version-List']
    }
    callback({ requestHeaders: details.requestHeaders })
  })
}

/**
 * 为嵌入式 webview 准备 session（单页架构专用）。
 *
 * 不创建 BrowserWindow，只设置 session 级 UA + 代理 + Client Hints 拦截器。
 * 渲染进程的 <webview> 使用相同 partition（persist:${profileId}）即可继承这些设置，
 * 保证首屏即使用正确 UA，无需 dom-ready 后再 setUserAgent + reload。
 */
export async function setupSession(profileId: string, clientHints: ClientHintsRegistry): Promise<void> {
  try {
    const profile = browserPorts().profiles.get(profileId)
    if (!profile) {
      throw new Error(`Profile 不存在: ${profileId}`)
    }

    const partition = `persist:${profileId}`
    const ses = session.fromPartition(partition)

    // 设置 session 级 UA
    if (profile.userAgent) {
      ses.setUserAgent(profile.userAgent)
    }

    // 设置代理（Profile.proxyConfig > Profile.proxy > 全局 AppSettings）
    await applyProxyToSession(ses, profile)

    // 计算 Client Hints 并缓存（供 webRequest 拦截器读取）
    clientHints.set(profileId, buildClientHints(profile))
    applyClientHintsInterceptor(ses, profileId, clientHints)
  } catch (err) {
    console.error(`[WindowManager] setupSession 失败 (${profileId}):`, err)
    throw new Error(
      `setupSession 失败: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * 为浏览器窗口准备独立 session（persist:${profileId}-browser）。
 *
 * 与 setupSession 的区别：
 *   - 使用独立 partition（与主窗口隔离）
 *   - 从主窗口 session 复制 Cookie（继承登录态）
 *   - 默认使用桌面端 UA（浏览器窗口是桌面尺寸）
 *   - 使用 region 感知代理（cn 直连 / global 系统代理）
 */
export async function setupBrowserSession(profileId: string, clientHints: ClientHintsRegistry): Promise<void> {
  try {
    const profile = browserPorts().profiles.get(profileId)
    if (!profile) {
      throw new Error(`Profile 不存在: ${profileId}`)
    }

    const browserPartition = `persist:${profileId}-browser`
    const ses = session.fromPartition(browserPartition)

    // 1. Cookie 复制：从主窗口 session 继承登录态
    const sourceSession = session.fromPartition(`persist:${profileId}`)
    await browserPorts().sessions.copyCookies(sourceSession, ses)

    // 2. 设置桌面端 UA（浏览器窗口默认桌面端）
    const desktopPreset = profile.aiDesktopPreset
      ? browserPorts().presets.get(profile.aiDesktopPreset)
      : null
    const desktopUA = desktopPreset?.userAgent || profile.userAgent
    if (desktopUA) {
      ses.setUserAgent(desktopUA)
    }

    // 3. Client Hints（桌面端）
    const desktopProfile: Profile = {
      ...profile,
      userAgent: desktopUA,
      platform: 'desktop',
      devicePreset: profile.aiDesktopPreset || profile.devicePreset,
    }
    const key = `${profileId}-browser`
    clientHints.set(key, buildClientHints(desktopProfile))
    applyClientHintsInterceptor(ses, key, clientHints)

    // 4. Region 感知代理
    await applyRegionBasedProxy(ses, profile)
  } catch (err) {
    console.error(`[WindowManager] setupBrowserSession 失败 (${profileId}):`, err)
    throw new Error(
      `setupBrowserSession 失败: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * 构建 Client Hints 头
 * - 当前 UA 与预设 UA 一致时，使用预设的品牌列表（保证一致性）
 * - UA 自定义时，从 UA 字符串推导
 */
export function buildClientHints(profile: Profile): ClientHints {
  const preset =
    profile.devicePreset !== 'custom' ? browserPorts().presets.get(profile.devicePreset) : null

  // 仅当当前 UA 与预设 UA 一致时，才使用预设的品牌列表
  if (preset && preset.userAgent === profile.userAgent) {
    return {
      secChUa: preset.brands
        .map((b) => `"${b.brand}";v="${b.version}"`)
        .join(', '),
      secChUaMobile: preset.chMobile ? '?1' : '?0',
      secChUaPlatform: `"${preset.chPlatform}"`,
    }
  }

  return deriveClientHintsFromUA(profile.userAgent, profile.platform)
}

/** 从 UA 字符串推导 Client Hints（用于自定义 UA） */
export function deriveClientHintsFromUA(
  ua: string,
  platform: Profile['platform'],
): ClientHints {
  const isMobile =
    platform === 'mobile' || /Mobile|Mobi|Android|iPhone|iPad/i.test(ua)

  // 推导 Sec-CH-UA-Platform
  let chPlatform = 'Windows'
  if (/Windows NT/i.test(ua)) chPlatform = 'Windows'
  else if (/Macintosh|Mac OS X/i.test(ua)) chPlatform = 'macOS'
  else if (/Android/i.test(ua)) chPlatform = 'Android'
  else if (/iPhone|iPad|iPod/i.test(ua)) chPlatform = 'iOS'
  else if (/Linux/i.test(ua)) chPlatform = 'Linux'

  // 推导 Sec-CH-UA 品牌列表（仅 Chrome 系浏览器携带此头）
  let secChUa = ''
  const chromeMatch = /Chrome\/(\d+)/.exec(ua)
  if (chromeMatch) {
    const v = chromeMatch[1]
    secChUa = `"Google Chrome";v="${v}", "Chromium";v="${v}", "Not.A/Brand";v="24"`
  }

  return {
    secChUa,
    secChUaMobile: isMobile ? '?1' : '?0',
    secChUaPlatform: `"${chPlatform}"`,
  }
}
