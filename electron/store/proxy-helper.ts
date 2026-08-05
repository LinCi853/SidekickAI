// electron/store/proxy-helper.ts — 代理配置计算与应用辅助
//
// 负责将 AppSettings 中的代理配置（mode + customProxy + 认证 + bypass）
// 转换为 Electron session.setProxy 所需的参数，并应用到指定 session。
// 代理认证通过 app.on('login') 全局事件处理（authInfo.isProxy 时填入凭据）。
//
// 优先级：Profile 级代理（profile.proxy）> 全局 AppSettings 代理。
// 若 profile.proxy 非空，则该 profile 的 session 使用 profile.proxy，
// 否则使用全局 AppSettings 中的代理配置。

import { session, app, net, type Session } from 'electron'
import { getAppSettings, type AppSettings } from './app-settings-store.js'
import { profileStore } from './profile-store.js'
import type { Profile } from '../shared/types.js'

/** 代理连通性测试 URL */
const PROXY_TEST_URL = 'https://www.baidu.com/blank.html'
/** 代理连通性测试超时（毫秒） */
const PROXY_TEST_TIMEOUT_MS = 10000

/** setProxy 参数（对齐 Electron 30 的 Electron.ProxyConfig） */
interface ProxyConfig {
  mode: 'system' | 'direct' | 'pac_script' | 'fixed_servers' | 'auto_detect'
  proxyRules?: string
  proxyBypassRules?: string
}

/** app.on('login') 处理器是否已注册（全局单例） */
let loginHandlerRegistered = false

/**
 * 根据全局 AppSettings 计算 setProxy 参数。
 * - system: 跟随系统代理
 * - direct: 不使用代理
 * - custom: 使用自定义代理地址 + bypass
 */
export function computeProxyConfig(settings?: AppSettings): ProxyConfig {
  const cfg = settings ?? getAppSettings()
  switch (cfg.proxyMode) {
    case 'direct':
      return { mode: 'direct' }
    case 'custom': {
      const rules = (cfg.customProxy || '').trim()
      if (!rules) return { mode: 'direct' }
      const config: ProxyConfig = { mode: 'fixed_servers', proxyRules: rules }
      const bypass = (cfg.proxyBypass || '').trim()
      if (bypass) config.proxyBypassRules = bypass
      return config
    }
    case 'system':
    default:
      return { mode: 'system' }
  }
}

/**
 * 注册全局代理认证处理器（app.on('login')）。
 * 当代理返回 407 认证请求时，自动填入 AppSettings 中的用户名密码。
 * 仅注册一次（loginHandlerRegistered 守卫）。
 */
export function registerProxyAuthHandler(): void {
  if (loginHandlerRegistered) return
  loginHandlerRegistered = true
  app.on('login', (_event, _webContents, _details, authInfo, callback) => {
    if (authInfo.isProxy) {
      const cfg = getAppSettings()
      if (cfg.proxyUsername || cfg.proxyPassword) {
        callback(cfg.proxyUsername, cfg.proxyPassword)
      } else {
        callback()
      }
    }
  })
}

/**
 * 将全局代理配置应用到指定 session。
 * 若 profileProxy 非空，优先使用 profileProxy（Profile 级覆盖）。
 */
export async function applyProxyToSession(
  ses: Session,
  profileProxy?: string,
): Promise<void> {
  const profileRules = (profileProxy || '').trim()
  if (profileRules) {
    await ses.setProxy({ mode: 'fixed_servers', proxyRules: profileRules })
    return
  }
  const config = computeProxyConfig()
  await ses.setProxy(config)
}

/**
 * Region 感知代理（用于浏览器窗口）。
 * 优先级：Profile.proxy > region 判断 > 全局 AppSettings
 *
 * region 判断规则：
 * - region = cn 且 hideForeignModels = false → 直连（国内平台不走代理）
 * - region = global → 系统代理
 * - 其他情况 → 回退到全局 AppSettings 代理
 */
export async function applyRegionBasedProxy(
  ses: Session,
  profile: Profile,
): Promise<void> {
  const profileRules = (profile.proxy || '').trim()
  if (profileRules) {
    await ses.setProxy({ mode: 'fixed_servers', proxyRules: profileRules })
    return
  }

  const region = profile.aiPlatformRegion
  const appSettings = getAppSettings()

  if (region === 'cn' && !appSettings.hideForeignModels) {
    await ses.setProxy({ mode: 'direct' })
    return
  }

  if (region === 'global') {
    await ses.setProxy({ mode: 'system' })
    return
  }

  const config = computeProxyConfig()
  await ses.setProxy(config)
}

/**
 * 将全局代理配置即时应用到默认 session + 所有已知 Profile partition session。
 * 在用户修改代理设置后调用，无需重启应用。
 */
export async function applyProxyToAllSessions(): Promise<void> {
  registerProxyAuthHandler()
  const config = computeProxyConfig()
  // 默认 session
  await session.defaultSession.setProxy(config)
  // 遍历所有 Profile 的 partition session（fromPartition 会自动创建不存在的 session）
  const profiles = profileStore.list()
  for (const profile of profiles) {
    const ses = session.fromPartition(`persist:${profile.id}`)
    // 仅应用全局代理；Profile 级 proxy 覆盖时使用 profile.proxy
    const profileRules = (profile.proxy || '').trim()
    if (profileRules) {
      await ses.setProxy({ mode: 'fixed_servers', proxyRules: profileRules })
    } else {
      await ses.setProxy(config)
    }
    // 浏览器窗口独立 session 也同步代理设置
    const browserSes = session.fromPartition(`persist:${profile.id}-browser`)
    if (profileRules) {
      await browserSes.setProxy({ mode: 'fixed_servers', proxyRules: profileRules })
    } else {
      await browserSes.setProxy(config)
    }
  }
}

/**
 * 测试代理连通性：通过当前代理配置请求一个轻量 URL，返回成功/延迟/消息。
 * 使用 net.request，它会遵循 session 的代理设置。
 */
export async function testProxyConnectivity(): Promise<{
  ok: boolean
  latencyMs?: number
  message: string
}> {
  const cfg = getAppSettings()
  if (cfg.proxyMode === 'direct') {
    return { ok: true, message: '直连模式，不使用代理' }
  }
  if (cfg.proxyMode === 'custom' && !(cfg.customProxy || '').trim()) {
    return { ok: false, message: '自定义模式未配置代理地址' }
  }

  // 测试前确保代理已应用到默认 session
  await applyProxyToAllSessions()

  const testUrl = PROXY_TEST_URL
  const start = Date.now()
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ ok: false, message: '连接超时（10s）' })
      }, PROXY_TEST_TIMEOUT_MS)
      const req = net.request({
        url: testUrl,
      })
      req.on('response', () => {
        clearTimeout(timer)
        const latency = Date.now() - start
        resolve({ ok: true, latencyMs: latency, message: `连接成功，延迟 ${latency}ms` })
      })
      req.on('error', (err) => {
        clearTimeout(timer)
        const latency = Date.now() - start
        resolve({
          ok: false,
          latencyMs: latency,
          message: `连接失败: ${err.message}`,
        })
      })
      req.end()
    })
  } catch (err) {
    const latency = Date.now() - start
    return {
      ok: false,
      latencyMs: latency,
      message: `测试异常: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * 代理失败兜底：当 webview 加载失败且错误码为代理相关时，
 * 临时将所有 session 切换到兜底模式（direct 或 system）。
 *
 * 仅当以下条件全部满足时才切换：
 *   1. AppSettings.proxyFallbackEnabled === true
 *   2. 当前 proxyMode === 'custom'（system/direct 模式无需兜底）
 *
 * 注意：此函数不修改 AppSettings，仅临时改变 session 代理。
 * 用户下次手动修改代理设置时，applyProxyToAllSessions 会恢复正常配置。
 *
 * @returns { switched, mode } switched=true 表示已切换，mode 为切换到的模式
 */
export async function applyProxyFallback(): Promise<{
  switched: boolean
  mode: 'direct' | 'system' | null
}> {
  const cfg = getAppSettings()
  if (!cfg.proxyFallbackEnabled) {
    return { switched: false, mode: null }
  }
  if (cfg.proxyMode !== 'custom') {
    return { switched: false, mode: null }
  }
  const fallbackMode = cfg.proxyFallbackMode
  console.warn(
    `[proxy] 代理失败兜底触发：custom → ${fallbackMode}（临时切换，不修改设置）`,
  )
  const config: ProxyConfig =
    fallbackMode === 'system' ? { mode: 'system' } : { mode: 'direct' }
  // 应用到默认 session + 所有 profile partition session（忽略 profile 级代理覆盖）
  try {
    await session.defaultSession.setProxy(config)
    const profiles = profileStore.list()
    for (const profile of profiles) {
      const ses = session.fromPartition(`persist:${profile.id}`)
      await ses.setProxy(config)
      // 浏览器窗口独立 session 也应用兜底
      const browserSes = session.fromPartition(`persist:${profile.id}-browser`)
      await browserSes.setProxy(config)
    }
  } catch (err) {
    console.error('[proxy] 兜底切换失败:', err)
    return { switched: false, mode: null }
  }
  return { switched: true, mode: fallbackMode }
}
