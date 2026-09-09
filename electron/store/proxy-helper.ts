// electron/store/proxy-helper.ts — 代理配置计算与应用辅助
//
// 负责将 AppSettings / Profile.proxyConfig 中的代理配置（mode + customProxy + 认证 + bypass）
// 转换为 Electron session.setProxy 所需的参数，并应用到指定 session。
// 代理认证通过 app.on('login') 全局事件处理（authInfo.isProxy 时填入凭据）。
//
// 优先级：Profile.proxyConfig（结构化完整配置）> Profile.proxy（旧字符串，兼容）> 全局 AppSettings 代理。
// Profile.proxyConfig 设置后，该 Profile 的 session 使用其独立配置（含认证 / bypass / 兜底），
// 完全覆盖全局 AppSettings 代理。

import { session, app, net, type Session } from 'electron'
import { ProxyAgent, type Dispatcher } from 'undici'
import { getAppSettings, type AppSettings } from './app-settings-store.js'
import { profileStore } from './profile-store.js'
import type { Profile, ProfileProxyConfig } from '../shared/types.js'

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

/** session 上标记 Profile id 的属性名（用于 app.on('login') 解析凭据） */
const PROFILE_ID_TAG = '__profileId'

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
 * 根据 Profile.proxyConfig 计算 setProxy 参数。
 * 逻辑与 computeProxyConfig 一致，但读取 Profile 级配置。
 */
export function computeProfileProxyConfig(proxyConfig: ProfileProxyConfig): ProxyConfig {
  switch (proxyConfig.proxyMode) {
    case 'direct':
      return { mode: 'direct' }
    case 'custom': {
      const rules = (proxyConfig.customProxy || '').trim()
      if (!rules) return { mode: 'direct' }
      const config: ProxyConfig = { mode: 'fixed_servers', proxyRules: rules }
      const bypass = (proxyConfig.proxyBypass || '').trim()
      if (bypass) config.proxyBypassRules = bypass
      return config
    }
    case 'system':
    default:
      return { mode: 'system' }
  }
}

/**
 * 获取 undici 代理 Dispatcher（供 AI 客户端等使用 undici 的模块走代理）。
 * - custom 模式：返回 ProxyAgent（HTTP/SOCKS5）
 * - direct / system：返回 undefined（undici 直连，system 模式暂不支持自动检测）
 */
export function getProxyDispatcher(): Dispatcher | undefined {
  const cfg = getAppSettings()
  if (cfg.proxyMode !== 'custom') return undefined
  const proxyUrl = (cfg.customProxy || '').trim()
  if (!proxyUrl) return undefined
  try {
    const opts: ConstructorParameters<typeof ProxyAgent>[0] = { uri: proxyUrl }
    if (cfg.proxyUsername) {
      opts.token = `Basic ${Buffer.from(`${cfg.proxyUsername}:${cfg.proxyPassword || ''}`).toString('base64')}`
    }
    return new ProxyAgent(opts)
  } catch (err) {
    console.warn('[proxy] 创建 ProxyAgent 失败:', err)
    return undefined
  }
}

/**
 * 注册全局代理认证处理器（app.on('login')）。
 * 当代理返回 407 认证请求时，按以下优先级填入凭据：
 *   1. webContents.session 上标记的 Profile 的 proxyConfig 凭据（custom 模式时）
 *   2. 全局 AppSettings 中的用户名密码
 * 仅注册一次（loginHandlerRegistered 守卫）。
 */
export function registerProxyAuthHandler(): void {
  if (loginHandlerRegistered) return
  loginHandlerRegistered = true
  app.on('login', (_event, webContents, _details, authInfo, callback) => {
    if (!authInfo.isProxy) {
      callback()
      return
    }
    // 1. 尝试从 webContents.session 上的 Profile 标记解析凭据
    const ses = webContents?.session as (Session & { __profileId?: string }) | undefined
    const profileId = ses?.[PROFILE_ID_TAG]
    if (profileId) {
      const profile = profileStore.get(profileId)
      if (profile?.proxyConfig && profile.proxyConfig.proxyMode === 'custom') {
        const u = profile.proxyConfig.proxyUsername
        const p = profile.proxyConfig.proxyPassword
        if (u || p) {
          callback(u, p)
          return
        }
      }
    }
    // 2. 回退到全局 AppSettings 凭据
    const cfg = getAppSettings()
    if (cfg.proxyUsername || cfg.proxyPassword) {
      callback(cfg.proxyUsername, cfg.proxyPassword)
    } else {
      callback()
    }
  })
}

/** 在 session 上标记 Profile id（供 app.on('login') 解析凭据） */
function tagSessionWithProfile(ses: Session, profileId: string): void {
  ;(ses as Session & { __profileId?: string })[PROFILE_ID_TAG] = profileId
}

/**
 * 将代理配置应用到指定 session。
 * 优先级：profile.proxyConfig（结构化）> profile.proxy（旧字符串）> 全局 AppSettings。
 * 传入 profile 时会在 session 上标记 profileId，供代理认证使用。
 */
export async function applyProxyToSession(
  ses: Session,
  profile?: Profile,
): Promise<void> {
  if (profile) {
    tagSessionWithProfile(ses, profile.id)
    // 1. Profile 级结构化配置
    if (profile.proxyConfig) {
      const config = computeProfileProxyConfig(profile.proxyConfig)
      await ses.setProxy(config)
      return
    }
    // 2. 旧字符串字段（兼容）
    const profileRules = (profile.proxy || '').trim()
    if (profileRules) {
      await ses.setProxy({ mode: 'fixed_servers', proxyRules: profileRules })
      return
    }
  }
  // 3. 全局 AppSettings
  const config = computeProxyConfig()
  await ses.setProxy(config)
}

/**
 * Region 感知代理（用于浏览器窗口）。
 * 优先级：Profile.proxyConfig（结构化）> Profile.proxy（旧字符串）> region 判断 > 全局 AppSettings
 *
 * region 判断规则（仅在未设置 Profile 级代理时生效）：
 * - region = cn 且 hideForeignModels = false → 直连（国内平台不走代理）
 * - region = global → 系统代理
 * - 其他情况 → 回退到全局 AppSettings 代理
 */
export async function applyRegionBasedProxy(
  ses: Session,
  profile: Profile,
): Promise<void> {
  tagSessionWithProfile(ses, profile.id)
  // 1. Profile 级结构化配置
  if (profile.proxyConfig) {
    const config = computeProfileProxyConfig(profile.proxyConfig)
    await ses.setProxy(config)
    return
  }
  // 2. 旧字符串字段（兼容）
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
 * 将代理配置即时应用到默认 session + 所有已知 Profile partition session。
 * 在用户修改代理设置后调用，无需重启应用。
 * 每个 Profile 按优先级应用其独立代理（proxyConfig > proxy > 全局）。
 */
export async function applyProxyToAllSessions(): Promise<void> {
  registerProxyAuthHandler()
  const globalConfig = computeProxyConfig()
  // 默认 session（无 Profile 关联，使用全局配置）
  await session.defaultSession.setProxy(globalConfig)
  // 遍历所有 Profile 的 partition session（fromPartition 会自动创建不存在的 session）
  const profiles = profileStore.list()
  for (const profile of profiles) {
    const ses = session.fromPartition(`persist:${profile.id}`)
    await applyProfileProxyToSession(ses, profile, globalConfig)
    // 浏览器窗口独立 session 也同步代理设置
    const browserSes = session.fromPartition(`persist:${profile.id}-browser`)
    await applyProfileProxyToSession(browserSes, profile, globalConfig)
  }
}

/**
 * 将单个 Profile 的代理应用到指定 session（内部辅助）。
 * 优先级：profile.proxyConfig > profile.proxy > globalConfig（全局配置）。
 */
async function applyProfileProxyToSession(
  ses: Session,
  profile: Profile,
  globalConfig: ProxyConfig,
): Promise<void> {
  tagSessionWithProfile(ses, profile.id)
  if (profile.proxyConfig) {
    const config = computeProfileProxyConfig(profile.proxyConfig)
    await ses.setProxy(config)
    return
  }
  const profileRules = (profile.proxy || '').trim()
  if (profileRules) {
    await ses.setProxy({ mode: 'fixed_servers', proxyRules: profileRules })
    return
  }
  await ses.setProxy(globalConfig)
}

/**
 * 将单个 Profile 的代理配置应用到其两个 partition session。
 * 在浏览器窗口设置中修改 proxyConfig 后调用，即时生效。
 */
export async function applyProfileProxy(profileId: string): Promise<void> {
  registerProxyAuthHandler()
  const profile = profileStore.get(profileId)
  if (!profile) return
  const globalConfig = computeProxyConfig()
  const ses = session.fromPartition(`persist:${profileId}`)
  await applyProfileProxyToSession(ses, profile, globalConfig)
  const browserSes = session.fromPartition(`persist:${profileId}-browser`)
  await applyProfileProxyToSession(browserSes, profile, globalConfig)
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
 * 测试指定 Profile 的代理连通性。
 * 通过该 Profile 的 partition session 发起请求，遵循其代理配置。
 */
export async function testProfileProxyConnectivity(profileId: string): Promise<{
  ok: boolean
  latencyMs?: number
  message: string
}> {
  const profile = profileStore.get(profileId)
  if (!profile) {
    return { ok: false, message: 'Profile 不存在' }
  }
  // 解析生效的代理模式（Profile.proxyConfig > 旧字符串视为 custom）
  let mode: 'system' | 'direct' | 'custom' = 'system'
  let customProxy = ''
  if (profile.proxyConfig) {
    mode = profile.proxyConfig.proxyMode
    customProxy = profile.proxyConfig.customProxy
  } else if ((profile.proxy || '').trim()) {
    mode = 'custom'
    customProxy = profile.proxy
  } else {
    mode = getAppSettings().proxyMode
    customProxy = getAppSettings().customProxy
  }
  if (mode === 'direct') {
    return { ok: true, message: '直连模式，不使用代理' }
  }
  if (mode === 'custom' && !customProxy.trim()) {
    return { ok: false, message: '自定义模式未配置代理地址' }
  }

  // 确保该 Profile 的代理已应用到其 partition session
  await applyProfileProxy(profileId)

  const partition = `persist:${profileId}`
  const testUrl = PROXY_TEST_URL
  const start = Date.now()
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ ok: false, message: '连接超时（10s）' })
      }, PROXY_TEST_TIMEOUT_MS)
      const req = net.request({ url: testUrl, partition })
      req.on('response', () => {
        clearTimeout(timer)
        const latency = Date.now() - start
        resolve({ ok: true, latencyMs: latency, message: `连接成功，延迟 ${latency}ms` })
      })
      req.on('error', (err) => {
        clearTimeout(timer)
        const latency = Date.now() - start
        resolve({ ok: false, latencyMs: latency, message: `连接失败: ${err.message}` })
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
 * 根据当前代理模式自动计算兜底模式（无需用户手动选择）：
 * - system → direct（系统代理不通时切直连）
 * - direct → system（直连不通时切系统代理）
 * - custom → direct（自定义代理不通时切直连）
 */
function computeFallbackMode(currentMode: string): 'direct' | 'system' {
  if (currentMode === 'system') return 'direct'
  if (currentMode === 'direct') return 'system'
  return 'direct'
}

/**
 * 代理失败兜底：临时切换到自动计算的兜底模式（不修改持久化设置）。
 * 兜底模式由当前模式自动决定，无需用户手动选择。
 *
 * @param profileId 可选：仅对指定 Profile 的 session 应用兜底；省略则全局兜底
 * @returns { switched, mode } switched=true 表示已切换，mode 为切换到的模式
 */
export async function applyProxyFallback(profileId?: string): Promise<{
  switched: boolean
  mode: 'direct' | 'system' | null
}> {
  console.warn(`[proxy-fallback] === applyProxyFallback 开始 === profileId=${profileId ?? '(全局)'}`)

  // Profile 级兜底
  if (profileId) {
    const profile = profileStore.get(profileId)
    if (!profile) {
      console.warn(`[proxy-fallback] Profile ${profileId} 不存在，跳过`)
      return { switched: false, mode: null }
    }
    const pc = profile.proxyConfig
    const effectiveMode = pc?.proxyMode ?? getAppSettings().proxyMode
    const fallbackEnabled = pc?.proxyFallbackEnabled ?? getAppSettings().proxyFallbackEnabled
    console.warn(`[proxy-fallback] Profile 兜底检查: effectiveMode=${effectiveMode} fallbackEnabled=${fallbackEnabled} hasProxyConfig=${!!pc}`)

    if (!fallbackEnabled) {
      console.warn('[proxy-fallback] 兜底开关未开启，跳过')
      return { switched: false, mode: null }
    }

    const fallbackMode = computeFallbackMode(effectiveMode)
    console.warn(`[proxy-fallback] 计算兜底模式: ${effectiveMode} → ${fallbackMode}`)
    const config: ProxyConfig = fallbackMode === 'system' ? { mode: 'system' } : { mode: 'direct' }

    try {
      const ses = session.fromPartition(`persist:${profileId}`)
      await ses.setProxy(config)
      console.warn(`[proxy-fallback] 已切换 persist:${profileId} → ${JSON.stringify(config)}`)
      const browserSes = session.fromPartition(`persist:${profileId}-browser`)
      await browserSes.setProxy(config)
      console.warn(`[proxy-fallback] 已切换 persist:${profileId}-browser → ${JSON.stringify(config)}`)
    } catch (err) {
      console.error(`[proxy-fallback] Profile ${profileId} session 切换失败:`, err)
      return { switched: false, mode: null }
    }
    console.warn(`[proxy-fallback] === Profile 兜底完成: switched=true mode=${fallbackMode} ===`)
    return { switched: true, mode: fallbackMode }
  }

  // 全局兜底
  const cfg = getAppSettings()
  console.warn(`[proxy-fallback] 全局兜底检查: proxyMode=${cfg.proxyMode} proxyFallbackEnabled=${cfg.proxyFallbackEnabled}`)

  if (!cfg.proxyFallbackEnabled) {
    console.warn('[proxy-fallback] 全局兜底开关未开启，跳过')
    return { switched: false, mode: null }
  }

  const fallbackMode = computeFallbackMode(cfg.proxyMode)
  console.warn(`[proxy-fallback] 计算兜底模式: ${cfg.proxyMode} → ${fallbackMode}`)
  const config: ProxyConfig = fallbackMode === 'system' ? { mode: 'system' } : { mode: 'direct' }

  try {
    await session.defaultSession.setProxy(config)
    console.warn(`[proxy-fallback] 已切换 defaultSession → ${JSON.stringify(config)}`)

    const profiles = profileStore.list()
    console.warn(`[proxy-fallback] 遍历 ${profiles.length} 个 Profile 的 session...`)
    for (const profile of profiles) {
      const ses = session.fromPartition(`persist:${profile.id}`)
      await ses.setProxy(config)
      const browserSes = session.fromPartition(`persist:${profile.id}-browser`)
      await browserSes.setProxy(config)
    }
    console.warn(`[proxy-fallback] 所有 session 已切换完成`)
  } catch (err) {
    console.error('[proxy-fallback] 全局兜底切换失败:', err)
    return { switched: false, mode: null }
  }

  console.warn(`[proxy-fallback] === 全局兜底完成: switched=true mode=${fallbackMode} ===`)
  return { switched: true, mode: fallbackMode }
}
