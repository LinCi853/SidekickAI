export type InjectionKind =
  | 'fingerprint' | 'ua-viewport' | 'block-rules' | 'cookie-handler' | 'spatial-nav'
  | 'login-detect' | 'chat-scrape' | 'enter-to-send' | 'cloud-pc' | 'gamepad-nav' | 'custom'

export interface InjectionContext {
  url?: string
  profileId?: string
  tabId?: string
  pageGeneration?: number
  isCurrent?: () => boolean
  profile?: { id: string; isAIPlatform?: boolean; aiPlatformId?: string; aiPlatformUrl?: string; aiInputSelector?: string; aiSendSelector?: string }
  enterToSend?: boolean
  manageEnterToSend?: boolean
  [key: string]: unknown
}

export interface InjectionPoint {
  id: string
  kind: InjectionKind
  ownerModule?: string
  scriptFn: (context?: InjectionContext) => string | null | Promise<string | null>
  cleanupScriptFn?: (context?: InjectionContext, replacing?: boolean) => string | null | Promise<string | null>
  enabled: (context?: InjectionContext) => boolean | Promise<boolean>
  reinjectOnNavigation?: boolean
  delayMs?: number
  order?: number
}

interface InjectionWebview { executeJavaScript: (script: string) => Promise<unknown> }
interface InjectionHandle { point: InjectionPoint; script: string; context: InjectionContext; stale?: boolean }
interface WebviewBinding {
  id: string
  webview: InjectionWebview
  context: InjectionContext
  handles: Map<string, InjectionHandle>
  pending: Map<string, Promise<boolean>>
  cancelDelays: Set<() => void>
  retired: boolean
}

class InjectionManagerImpl {
  private readonly points = new Map<string, InjectionPoint>()
  private readonly bindings = new Map<string, WebviewBinding>()
  private readonly moduleGenerations = new Map<string, number>()

  register(point: InjectionPoint): void { this.points.set(point.id, point) }
  registerMany(points: InjectionPoint[]): void { for (const point of points) this.register(point) }

  private bind(id: string, webview: InjectionWebview, url?: string, context?: InjectionContext): WebviewBinding {
    const existing = this.bindings.get(id)
    const target = { ...(context ?? existing?.context), url: url ?? context?.url ?? existing?.context.url }
    if (existing && existing.webview === webview && existing.context.url === target.url
      && existing.context.pageGeneration === target.pageGeneration) {
      existing.context = target
      return existing
    }
    const inherited = existing?.webview === webview
      ? new Map([...existing.handles].map(([pointId, handle]) => [pointId, { ...handle, stale: true }])) : new Map()
    if (existing) void this.retire(existing, existing.webview !== webview)
    const binding: WebviewBinding = { id, webview, context: target, handles: inherited, pending: new Map(),
      cancelDelays: new Set(), retired: false }
    this.bindings.set(id, binding)
    return binding
  }

  private active(binding: WebviewBinding): boolean {
    if (binding.retired || this.bindings.get(binding.id) !== binding) return false
    try { return binding.context.isCurrent?.() !== false } catch { return false }
  }

  private async cleanup(binding: WebviewBinding, handle: InjectionHandle, replacing = false): Promise<void> {
    if (!handle.point.cleanupScriptFn) return
    try {
      const script = await handle.point.cleanupScriptFn(handle.context, replacing)
      const replacement = this.bindings.get(binding.id)
      if (replacement && replacement !== binding && replacement.webview === binding.webview) return
      if (script) await binding.webview.executeJavaScript(script)
    } catch (error) { console.warn('[injection-manager] Cleanup failed (' + handle.point.id + '):', error) }
  }

  private async retire(binding: WebviewBinding, cleanup = true): Promise<void> {
    binding.retired = true
    if (this.bindings.get(binding.id) === binding) this.bindings.delete(binding.id)
    for (const cancel of binding.cancelDelays) cancel()
    const handles = [...binding.handles.values()]
    binding.handles.clear()
    if (cleanup) await Promise.all(handles.map(handle => this.cleanup(binding, handle)))
  }

  private delay(binding: WebviewBinding, milliseconds: number): Promise<void> {
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); binding.cancelDelays.delete(finish); resolve() }
      const timer = setTimeout(finish, milliseconds)
      binding.cancelDelays.add(finish)
    })
  }

  private injectPoint(binding: WebviewBinding, point: InjectionPoint): Promise<boolean> {
    const pending = binding.pending.get(point.id)
    const generation = point.ownerModule ? this.moduleGenerations.get(point.ownerModule) : undefined
    const current = () => this.active(binding) && this.points.get(point.id) === point
      && (!point.ownerModule || this.moduleGenerations.get(point.ownerModule) === generation)
    if (pending) return pending.then(() => current() ? this.injectPoint(binding, point) : false)
    const operation = Promise.resolve().then(async () => {
      if (!current()) return false
      const context = { ...binding.context }
      let enabled = false
      try { enabled = await point.enabled(context) } catch { /* A failed preference cannot enable injection. */ }
      if (!current()) return false
      const existing = binding.handles.get(point.id)
      if (!enabled) {
        binding.handles.delete(point.id)
        if (existing) await this.cleanup(binding, existing)
        return false
      }
      if (existing?.point === point && !existing.stale && !point.reinjectOnNavigation) return true
      const script = await point.scriptFn(context)
      if (!current()) return false
      if (!script) {
        binding.handles.delete(point.id)
        if (existing) await this.cleanup(binding, existing)
        return false
      }
      if (existing?.point === point && !existing.stale && existing.script === script && existing.context.url === context.url) return true
      if (existing) {
        binding.handles.delete(point.id)
        await this.cleanup(binding, existing, true)
        if (!current()) return false
      }
      if (point.delayMs) await this.delay(binding, point.delayMs)
      if (!current()) return false
      await binding.webview.executeJavaScript(script)
      const handle: InjectionHandle = { point, script, context }
      if (!current()) { await this.cleanup(binding, handle); return false }
      binding.handles.set(point.id, handle)
      return true
    }).catch(error => {
      console.warn('[injection-manager] Injection failed (' + point.id + '):', error)
      return false
    }).finally(() => { if (binding.pending.get(point.id) === operation) binding.pending.delete(point.id) })
    binding.pending.set(point.id, operation)
    return operation
  }

  async injectAll(id: string, webview: InjectionWebview, url?: string, context?: InjectionContext,
    skipKinds?: InjectionKind[]): Promise<void> {
    const binding = this.bind(id, webview, url, context)
    const points = [...this.points.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
    for (const point of points) {
      if (!this.active(binding)) return
      if (!skipKinds?.includes(point.kind)) await this.injectPoint(binding, point)
    }
  }

  async injectOne(pointId: string, id: string, webview: InjectionWebview, context?: InjectionContext): Promise<boolean> {
    const point = this.points.get(pointId)
    if (!point) return false
    return this.injectPoint(this.bind(id, webview, context?.url, context), point)
  }

  disposeWebview(id: string, webview?: InjectionWebview): Promise<void> {
    const binding = this.bindings.get(id)
    if (webview && binding?.webview !== webview) return Promise.resolve()
    return binding ? this.retire(binding) : Promise.resolve()
  }

  async disposeModule(moduleId: string): Promise<void> {
    this.moduleGenerations.set(moduleId, (this.moduleGenerations.get(moduleId) ?? 0) + 1)
    const cleanup: Promise<void>[] = []
    for (const binding of this.bindings.values()) {
      for (const [id, handle] of binding.handles) {
        if (handle.point.ownerModule !== moduleId) continue
        binding.handles.delete(id)
        cleanup.push(this.cleanup(binding, handle))
      }
    }
    await Promise.all(cleanup)
  }

  async disposeAll(): Promise<void> { await Promise.all([...this.bindings.values()].map(binding => this.retire(binding))) }

  async refreshKinds(kinds: InjectionKind[]): Promise<void> {
    await Promise.all([...this.bindings.values()].map(async binding => {
      for (const point of this.points.values()) {
        if (!kinds.includes(point.kind)) continue
        await binding.pending.get(point.id)
        if (!this.active(binding)) return
        await this.injectPoint(binding, point)
      }
    }))
  }
  has(pointId: string): boolean { return this.points.has(pointId) }

  getStatus(id: string): Array<{ pointId: string; kind: InjectionKind; injected: boolean }> {
    return [...(this.bindings.get(id)?.handles.values() ?? [])].map(handle => ({
      pointId: handle.point.id, kind: handle.point.kind, injected: true,
    }))
  }

  getStats(): { points: number; activeWebviews: number; totalInjections: number } {
    return { points: this.points.size, activeWebviews: this.bindings.size,
      totalInjections: [...this.bindings.values()].reduce((sum, binding) => sum + binding.handles.size, 0) }
  }
}

export const injectionManager = new InjectionManagerImpl()
let stopPreferenceUpdates: (() => void) | undefined

function hostname(context?: InjectionContext): string {
  try { return new URL(context?.url ?? '').hostname } catch { return '' }
}

export async function registerDefaultInjectionPoints(): Promise<void> {
  const [api, blocker, cookie, spatial, scripts] = await Promise.all([
    import('./electron-api'), import('./webview-blocker'), import('./cookie-handler'),
    import('./webview-spatial-nav'), import('../pages/MainView/scripts'),
  ])
  injectionManager.registerMany([
    { id: 'fingerprint', kind: 'fingerprint', order: 10, scriptFn: () => null, enabled: () => true },
    { id: 'ua-viewport', kind: 'ua-viewport', order: 20, scriptFn: () => null, enabled: () => true, reinjectOnNavigation: true },
    { id: 'block-rules', kind: 'block-rules', order: 30, reinjectOnNavigation: true,
      enabled: async () => !(await api.getAppSettings()).disableAllBlockRules,
      scriptFn: async context => {
        const rules = (await api.listBlockRules()).filter(rule => rule.enabled && blocker.matchDomain(rule.domainPattern, hostname(context)))
        return rules.length ? blocker.buildBlockerScript(rules) : null
      },
      cleanupScriptFn: () => blocker.buildBlockerCleanupScript(),
    },
    { id: 'cookie-handler', kind: 'cookie-handler', order: 40, reinjectOnNavigation: true,
      enabled: async () => (await api.getAppSettings()).cookieHandlerEnabled !== false,
      scriptFn: async context => {
        const settings = await api.getAppSettings()
        return cookie.buildCookieHandlerScript(hostname(context), { whitelist: settings.cookieWhitelist,
          blacklist: settings.cookieBlacklist, cooldownMs: settings.cookiePopupCooldownMs, enabled: settings.cookieHandlerEnabled })
      },
      cleanupScriptFn: () => cookie.buildCookieHandlerCleanupScript(),
    },
    { id: 'enter-to-send', kind: 'enter-to-send', order: 45, reinjectOnNavigation: true,
      enabled: async context => context?.manageEnterToSend === true && (await api.getAppSettings()).enterToSend !== false,
      scriptFn: async context => {
        const profile = context?.profile
        const platforms = profile?.isAIPlatform ? await api.listAIPlatforms() : []
        const platform = platforms.find(item => item.id === profile?.aiPlatformId)
          ?? platforms.find(item => item.url === profile?.aiPlatformUrl)
        return scripts.buildEnterToSendScript({ enabled: true,
          inputSelector: profile?.aiInputSelector || (context?.inputSelector as string | null | undefined) || platform?.inputSelector,
          sendSelector: profile?.aiSendSelector || (context?.sendSelector as string | null | undefined) || platform?.sendSelector,
          pageAdapter: platform?.pageAdapter })
      },
      cleanupScriptFn: () => scripts.buildEnterToSendCleanupScript(),
    },
    { id: 'spatial-nav', kind: 'spatial-nav', order: 50, scriptFn: () => spatial.buildSpatialNavScript(),
      enabled: () => true, reinjectOnNavigation: true,
      cleanupScriptFn: (_context, replacing) => spatial.buildSpatialNavCleanupScript(replacing) },
  ])
  stopPreferenceUpdates?.()
  const refresh = (kinds: InjectionKind[]) => {
    void injectionManager.refreshKinds(kinds).catch(error => console.warn('[injection-manager] Preference update failed:', error))
  }
  const offSettings = api.onAppSettingsChanged(() => refresh(['block-rules', 'cookie-handler', 'enter-to-send']))
  const offRules = api.onBlockRulesChanged(() => refresh(['block-rules']))
  stopPreferenceUpdates = () => { offSettings(); offRules() }
}
