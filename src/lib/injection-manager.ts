/**
 * src/lib/injection-manager.ts — 渲染层统一注入管理器
 *
 * 管理所有功能的 webview 脚本注入，与主进程 InjectionBroker 对应。
 * 渲染层的 executeJavaScript 调用不能直接走主进程管线，因此需要本地管理：
 *   - 注册注入点（脚本 + 条件）
 *   - 按功能开关决定是否注入（主动式：开关关闭时完全不注入）
 *   - 提供统一的注入/撤销接口
 *   - 支持导航后重新注入
 *
 * 设计原则：
 *   - 主动式注入：功能开关关闭时不注入，而非注入后再清理
 *   - 所有功能必须通过此管理器注入（包括核心功能）
 *   - 管理器内部追踪所有注入状态，支持批量清理
 *
 * 能力清单（Capability Registry）：
 *   ┌─────────────────┬──────────────────┬────────────────────────────┬──────────┐
 *   │ 能力 ID          │ 类型             │ 控制开关                     │ 分类     │
 *   ├─────────────────┼──────────────────┼────────────────────────────┼──────────┤
 *   │ fingerprint     │ fingerprint      │ 始终注入                     │ 核心     │
 *   │ ua-viewport     │ ua-viewport      │ 始终注入                     │ 核心     │
 *   │ block-rules     │ block-rules      │ disableAllBlockRules       │ 可关闭   │
 *   │ cookie-handler  │ cookie-handler   │ cookieHandlerEnabled       │ 可关闭   │
 *   │ spatial-nav     │ spatial-nav      │ Ctrl+G 运行时              │ 可关闭   │
 *   │ login-detect    │ login-detect     │ profile.isAIPlatform       │ 可关闭   │
 *   │ chat-scrape     │ chat-scrape      │ 始终注入                     │ 核心     │
 *   │ cloud-pc        │ cloud-pc         │ 浏览器模块开关              │ 模块级   │
 *   │ gamepad-nav     │ gamepad-nav      │ 浏览器模块开关              │ 模块级   │
 *   └─────────────────┴──────────────────┴────────────────────────────┴──────────┘
 */

// ==================== 类型定义 ====================

/** 注入点类型 */
export type InjectionKind =
  | 'fingerprint'      // 指纹注入
  | 'ua-viewport'      // UA/Viewport 注入
  | 'block-rules'      // 广告屏蔽规则
  | 'cookie-handler'   // Cookie 弹窗处理
  | 'spatial-nav'      // 空间导航
  | 'login-detect'     // 登录检测
  | 'chat-scrape'      // 对话抓取
  | 'enter-to-send'    // 回车发送配置
  | 'cloud-pc'         // 云电脑模式
  | 'gamepad-nav'      // 手柄导航
  | 'custom'           // 自定义

/** 注入点定义 */
export interface InjectionPoint {
  /** 唯一标识 */
  id: string
  /** 注入类型 */
  kind: InjectionKind
  /** 所属模块（可选，用于模块禁用时批量撤销） */
  ownerModule?: string
  /** 脚本生成函数（惰性，按需生成） */
  scriptFn: () => string | null | Promise<string | null>
  /** 是否启用（功能开关） */
  enabled: () => boolean | Promise<boolean>
  /** 导航后是否重新注入 */
  reinjectOnNavigation?: boolean
  /** 注入时机：dom-ready 后延迟注入（毫秒） */
  delayMs?: number
  /** 注入顺序（越小越先注入） */
  order?: number
}

/** 注入句柄 */
interface InjectionHandle {
  point: InjectionPoint
  webviewId: string
  injected: boolean
  lastUrl?: string
  dispose: () => void
}

// ==================== 注入管理器 ====================

class InjectionManagerImpl {
  /** 注册的注入点定义 */
  private readonly points = new Map<string, InjectionPoint>()
  /** 活跃的注入句柄：webviewId -> handles */
  private readonly handles = new Map<string, Map<string, InjectionHandle>>()
  /** 全局开关状态缓存 */
  private readonly stateCache = new Map<string, boolean>()

  // ==================== 注册 ====================

  /** 注册注入点（启动时调用） */
  register(point: InjectionPoint): void {
    this.points.set(point.id, point)
    console.log(`[injection-manager] 已注册注入点: ${point.id} (${point.kind})`)
  }

  /** 批量注册 */
  registerMany(points: InjectionPoint[]): void {
    for (const p of points) this.register(p)
  }

  // ==================== 注入执行 ====================

  /**
   * 对指定 webview 执行所有已注册的注入。
   * @param webviewId webview 唯一标识（通常是 tabId）
   * @param webview webview 元素（需有 executeJavaScript 方法）
   * @param url 当前 URL（用于判断是否需要重新注入）
   * @param context 注入上下文（profile、配置等）
   * @param skipKinds 跳过的注入类型（可选）
   */
  async injectAll(
    webviewId: string,
    webview: { executeJavaScript: (script: string) => Promise<unknown> },
    url?: string,
    context?: InjectionContext,
    skipKinds?: InjectionKind[],
  ): Promise<void> {
    let handles = this.handles.get(webviewId)
    if (!handles) {
      handles = new Map()
      this.handles.set(webviewId, handles)
    }

    // 按 order 排序
    const sortedPoints = [...this.points.entries()].sort((a, b) => (a[1].order ?? 100) - (b[1].order ?? 100))

    for (const [pointId, point] of sortedPoints) {
      // 跳过指定类型
      if (skipKinds?.includes(point.kind)) continue

      // 检查是否启用
      let isEnabled: boolean
      try {
        isEnabled = await point.enabled()
      } catch {
        isEnabled = false
      }
      if (!isEnabled) {
        // 如果之前有注入，需要撤销
        const existing = handles.get(pointId)
        if (existing?.injected) {
          existing.dispose()
          existing.injected = false
        }
        continue
      }

      // 检查是否需要重新注入（URL 变化）
      const existing = handles.get(pointId)
      if (existing?.injected && !point.reinjectOnNavigation) continue
      if (existing?.injected && existing.lastUrl === url) continue

      // 生成脚本
      let script: string | null
      try {
        script = await point.scriptFn()
      } catch (err) {
        console.warn(`[injection-manager] 生成脚本失败 (${pointId}):`, err)
        continue
      }
      if (!script) continue

      // 执行注入
      try {
        if (point.delayMs) {
          await new Promise((resolve) => setTimeout(resolve, point.delayMs))
        }
        await webview.executeJavaScript(script)

        // 更新句柄
        const handle: InjectionHandle = {
          point,
          webviewId,
          injected: true,
          lastUrl: url,
          dispose: () => {
            // 脚本注入不可撤销，只能标记为未注入
            handle.injected = false
          },
        }
        handles.set(pointId, handle)
      } catch (err) {
        console.warn(`[injection-manager] 注入失败 (${pointId}):`, err)
      }
    }
  }

  /**
   * 对指定 webview 执行单个注入点。
   */
  async injectOne(
    pointId: string,
    webviewId: string,
    webview: { executeJavaScript: (script: string) => Promise<unknown> },
  ): Promise<boolean> {
    const point = this.points.get(pointId)
    if (!point) return false

    let isEnabled: boolean
    try {
      isEnabled = await point.enabled()
    } catch {
      isEnabled = false
    }
    if (!isEnabled) return false

    let script: string | null
    try {
      script = await point.scriptFn()
    } catch {
      return false
    }
    if (!script) return false

    try {
      await webview.executeJavaScript(script)

      let handles = this.handles.get(webviewId)
      if (!handles) {
        handles = new Map()
        this.handles.set(webviewId, handles)
      }
      handles.set(pointId, {
        point,
        webviewId,
        injected: true,
        dispose: () => {},
      })
      return true
    } catch {
      return false
    }
  }

  // ==================== 撤销 ====================

  /** 撤销指定 webview 的所有注入 */
  disposeWebview(webviewId: string): void {
    const handles = this.handles.get(webviewId)
    if (!handles) return
    for (const handle of handles.values()) {
      handle.dispose()
    }
    this.handles.delete(webviewId)
  }

  /** 撤销指定模块的所有注入 */
  disposeModule(moduleId: string): void {
    for (const [webviewId, handles] of this.handles) {
      for (const [pointId, handle] of handles) {
        if (handle.point.ownerModule === moduleId) {
          handle.dispose()
          handles.delete(pointId)
        }
      }
      if (handles.size === 0) {
        this.handles.delete(webviewId)
      }
    }
  }

  /** 撤销全部 */
  disposeAll(): void {
    for (const handles of this.handles.values()) {
      for (const handle of handles.values()) {
        handle.dispose()
      }
    }
    this.handles.clear()
  }

  // ==================== 查询 ====================

  /** 查询注入点是否已注册 */
  has(pointId: string): boolean {
    return this.points.has(pointId)
  }

  /** 查询指定 webview 的注入状态 */
  getStatus(webviewId: string): Array<{ pointId: string; kind: InjectionKind; injected: boolean }> {
    const handles = this.handles.get(webviewId)
    if (!handles) return []
    return [...handles.values()].map((h) => ({
      pointId: h.point.id,
      kind: h.point.kind,
      injected: h.injected,
    }))
  }

  /** 统计 */
  getStats(): { points: number; activeWebviews: number; totalInjections: number } {
    let totalInjections = 0
    for (const handles of this.handles.values()) {
      totalInjections += handles.size
    }
    return {
      points: this.points.size,
      activeWebviews: this.handles.size,
      totalInjections,
    }
  }
}

/** 注入上下文 */
export interface InjectionContext {
  /** 当前 profile */
  profile?: {
    id: string
    isAIPlatform?: boolean
    aiInputSelector?: string
    aiSendSelector?: string
  }
  /** Enter 发送配置 */
  enterToSend?: boolean
  /** 其他配置 */
  [key: string]: unknown
}

/** 单例 */
export const injectionManager = new InjectionManagerImpl()

// ==================== 预定义注入点 ====================
// 注意：以下导入需要在文件顶部，但为了保持结构清晰放在这里
// 实际使用时会在 registerDefaultInjectionPoints 中延迟导入

/** 广告屏蔽规则注入点 */
let BLOCK_RULES_INJECTION: InjectionPoint

/** Cookie 弹窗处理注入点 */
let COOKIE_HANDLER_INJECTION: InjectionPoint

/** 空间导航注入点 */
let SPATIAL_NAV_INJECTION: InjectionPoint

/** 登录检测注入点 */
let LOGIN_DETECT_INJECTION: InjectionPoint

/** 对话抓取注入点 */
let CHAT_SCRAPE_INJECTION: InjectionPoint

/** Enter 发送注入点 */
let ENTER_TO_SEND_INJECTION: InjectionPoint

/** UA/Viewport 注入点 */
let UA_VIEWPORT_INJECTION: InjectionPoint

/** 指纹注入点 */
let FINGERPRINT_INJECTION: InjectionPoint

/**
 * 注册所有默认注入点。
 * 在应用初始化时调用一次。
 */
export async function registerDefaultInjectionPoints(): Promise<void> {
  // 延迟导入避免循环依赖
  const [
    { listBlockRules, getAppSettings },
    { buildBlockerScript },
    { buildCookieHandlerScript },
    { buildSpatialNavScript },
  ] = await Promise.all([
    import('./electron-api'),
    import('./webview-blocker'),
    import('./cookie-handler'),
    import('./webview-spatial-nav'),
  ])

  // 从 scripts.ts 导入对话抓取和登录检测脚本
  const { SCRAPE_CHAT_SCRIPT, DETECT_LOGIN_SCRIPT } = await import('../pages/MainView/scripts')

  // 指纹脚本生成函数
  const { getFingerprintScript } = await import('./electron-api')

  // Viewport 注入函数
  const { injectViewportAndPopupGuard } = await import('./webview')

  // ==================== 定义注入点 ====================

  /** 指纹注入点 */
  FINGERPRINT_INJECTION = {
    id: 'fingerprint',
    kind: 'fingerprint',
    order: 10,
    scriptFn: async () => {
      // 指纹脚本需要 profileId，从 context 获取
      // 这里返回 null，实际注入由 injectAll 的 context 参数提供
      return null
    },
    enabled: () => true,
    reinjectOnNavigation: false,
  }

  /** UA/Viewport 注入点 */
  UA_VIEWPORT_INJECTION = {
    id: 'ua-viewport',
    kind: 'ua-viewport',
    order: 20,
    scriptFn: async () => {
      // Viewport 脚本由 injectViewportAndPopupGuard 生成
      // 这里返回 null，实际注入由专门的函数处理
      return null
    },
    enabled: () => true,
    reinjectOnNavigation: true,
  }

  /** 广告屏蔽规则注入点 */
  BLOCK_RULES_INJECTION = {
    id: 'block-rules',
    kind: 'block-rules',
    order: 30,
    scriptFn: async () => {
      const [rules, settings] = await Promise.all([listBlockRules(), getAppSettings()])
      const hostname = window.location?.hostname || ''
      const matched = rules.filter((r) => r.enabled && matchDomain(r.domainPattern, hostname))
      return matched.length > 0 ? buildBlockerScript(matched) : null
    },
    enabled: async () => {
      const settings = await getAppSettings()
      return !settings.disableAllBlockRules
    },
    reinjectOnNavigation: true,
  }

  /** Cookie 弹窗处理注入点 */
  COOKIE_HANDLER_INJECTION = {
    id: 'cookie-handler',
    kind: 'cookie-handler',
    order: 40,
    scriptFn: async () => {
      const settings = await getAppSettings()
      const hostname = window.location?.hostname || ''
      return buildCookieHandlerScript(hostname, {
        whitelist: settings.cookieWhitelist,
        blacklist: settings.cookieBlacklist,
        cooldownMs: settings.cookiePopupCooldownMs,
        enabled: settings.cookieHandlerEnabled,
      })
    },
    enabled: async () => {
      const settings = await getAppSettings()
      return settings.cookieHandlerEnabled !== false
    },
    reinjectOnNavigation: true,
  }

  /** 空间导航注入点 */
  SPATIAL_NAV_INJECTION = {
    id: 'spatial-nav',
    kind: 'spatial-nav',
    order: 50,
    scriptFn: () => buildSpatialNavScript(),
    enabled: () => true,
    reinjectOnNavigation: true,
  }

  /** 登录检测注入点 */
  LOGIN_DETECT_INJECTION = {
    id: 'login-detect',
    kind: 'login-detect',
    order: 60,
    delayMs: 3000, // 等待 3 秒让登录后元素渲染
    scriptFn: () => DETECT_LOGIN_SCRIPT,
    enabled: () => true, // 始终启用，由 profile.isAIPlatform 控制
    reinjectOnNavigation: true,
  }

  /** 对话抓取注入点 */
  CHAT_SCRAPE_INJECTION = {
    id: 'chat-scrape',
    kind: 'chat-scrape',
    order: 70,
    scriptFn: () => SCRAPE_CHAT_SCRIPT,
    enabled: () => true,
    reinjectOnNavigation: false, // 对话抓取是轮询模式，不需要重新注入
  }

  // 注册所有注入点
  // 注意：enter-to-send 不在此处注册，由 useWebviewInjection 的 buildEnterToSendScript() 处理
  // 以避免竞态：injection-manager 的 stub 先设置 __ai_enter_send_injected__=true 导致
  // buildEnterToSendScript() 跳过 keydown 监听器注册
  injectionManager.registerMany([
    FINGERPRINT_INJECTION,
    UA_VIEWPORT_INJECTION,
    BLOCK_RULES_INJECTION,
    COOKIE_HANDLER_INJECTION,
    SPATIAL_NAV_INJECTION,
    LOGIN_DETECT_INJECTION,
    CHAT_SCRAPE_INJECTION,
  ])

  console.log('[injection-manager] 已注册所有默认注入点')
}

// ==================== 辅助函数 ====================

function matchDomain(pattern: string, hostname: string): boolean {
  if (!pattern) return false
  if (pattern === '*') return true
  if (!hostname) return false
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1)
    return hostname.endsWith(suffix) || hostname === pattern.slice(2)
  }
  return pattern === hostname
}
