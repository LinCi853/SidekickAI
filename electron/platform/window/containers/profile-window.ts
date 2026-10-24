// electron/platform/window/containers/profile-window.ts — 多 Profile 独立窗口
//
// 核心机制：每个 Profile 用独立 session.partition（persist:${profileId}），
// 实现 Cookie / Storage / Cache / UA / 指纹的完全隔离。
// 通过 BrowserWindow + session.webRequest 拦截 Client Hints 头，保证 UA 一致性。
// 移动端 Profile 启用设备模拟，指纹通过 dom-ready 后 executeJavaScript 注入（MVP）。
//
// session 级设置（UA / 代理 / Client Hints）在 ../session.ts，本文件只负责窗口。

import { BrowserWindow, session, type WebContents } from 'electron'
import type { FingerprintEngine } from '../../../browser/fingerprint.js'
import type { Profile } from '../../../shared/types.js'
import { profileStore } from '../../../browser/profile-store.js'
import { getPreset } from '../../../browser/preset-store.js'
import { applyProxyToSession } from '../../../store/proxy-helper.js'
import { WINDOW_BACKGROUND_COLOR, getWebviewPreloadPath } from '../helpers.js'
import { buildWindowConfig } from '../window-config-builder.js'
import { registerWindowRetirement } from '../window-retirement.js'
import { getAppWindowIcon, reapplyWindowIcon } from '../app-icon.js'
import { browserWindowRetirementSeconds } from '../../../shared/background-policy.js'
import { isLowMemoryMode } from '../../../store/low-memory-mode.js'
import {
  applyClientHintsInterceptor,
  buildClientHints,
  setupBrowserSession,
  setupSession,
  type ClientHints,
} from '../session.js'

/** Profile 窗口最小宽度 */
const PROFILE_WINDOW_MIN_WIDTH = 240
/** Profile 窗口最小高度 */
const PROFILE_WINDOW_MIN_HEIGHT = 320

/**
 * 多 Profile 窗口管理器
 * 管理 BrowserWindow 的创建 / 销毁 / UA 切换 / 设备切换。
 * 每个 Profile 窗口使用独立 session partition，实现多身份隔离。
 */
export class WindowManager {
  /** profileId -> BrowserWindow */
  private windows = new Map<string, BrowserWindow>()
  /** profileId -> 当前 Client Hints 配置（运行时可变，供 webRequest 拦截器读取） */
  private clientHints = new Map<string, ClientHints>()

  /** profileId -> 在途的 openProfile：检查与登记之间有 await，需要去重防止双开 */
  private openingProfiles = new Map<string, Promise<void>>()

  constructor(private fingerprintEngine: FingerprintEngine) {}

  /**
   * 打开 Profile 窗口
   * - 已打开则 focus 并返回
   * - 创建 BrowserWindow，设置 partition / UA / 代理 / Client Hints 拦截 / 设备模拟
   * - 加载 AI 平台 URL 或 about:blank
   * - dom-ready 后注入指纹覆盖脚本
   */
  async openProfile(profileId: string): Promise<void> {
    // 「已存在检查」与「windows.set」之间有 await（代理应用等），
    // 双击/双触发 WINDOW_OPEN 会为同一 Profile 开出两个窗口、前者脱管，
    // 且其 closed 处理会误删对方的映射项；在途调用直接复用同一次打开
    const inFlight = this.openingProfiles.get(profileId)
    if (inFlight) return inFlight
    const opening = this.doOpenProfile(profileId)
    this.openingProfiles.set(profileId, opening)
    void opening.finally(() => {
      if (this.openingProfiles.get(profileId) === opening) this.openingProfiles.delete(profileId)
    }).catch(() => { /* 拒绝由返回给调用方的 opening 传递 */ })
    return opening
  }

  private async doOpenProfile(profileId: string): Promise<void> {
    try {
      // 已打开则聚焦
      const existing = this.windows.get(profileId)
      if (existing && !existing.isDestroyed()) {
        existing.focus()
        return
      }

      const profile = profileStore.get(profileId)
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
      const hints = buildClientHints(profile)
      this.clientHints.set(profileId, hints)

      // 拦截请求头，注入 Sec-CH-UA 系列 Client Hints（保证 UA 一致性）
      applyClientHintsInterceptor(ses, profileId, this.clientHints)

      // 创建窗口
      const win = new BrowserWindow(buildWindowConfig({
        icon: getAppWindowIcon(),
        width: profile.width,
        height: profile.height,
        x: profile.x,
        y: profile.y,
        alwaysOnTop: profile.alwaysOnTop,
        // 标准窗口框架：可拖拽移动 + 可调整大小 + 有标题栏
        frame: true,
        resizable: true,
        minWidth: PROFILE_WINDOW_MIN_WIDTH,
        minHeight: PROFILE_WINDOW_MIN_HEIGHT,
        backgroundColor: WINDOW_BACKGROUND_COLOR,
        webPreferences: {
          // 关键：session.partition 隔离，Cookie/Storage/Cache 完全独立
          partition,
          preload: getWebviewPreloadPath(),
          contextIsolation: true,
          sandbox: false,
          nodeIntegration: false,
        },
      }))

      this.windows.set(profileId, win)
      win.on('minimize', () => reapplyWindowIcon(win))
      win.on('restore', () => reapplyWindowIcon(win))
      // 后台闲置自动关闭，释放该 profile 窗口的 guest
      registerWindowRetirement(win, {
        seconds: () => browserWindowRetirementSeconds(isLowMemoryMode()),
      })

      // 设置 webContents UA（与 session UA 一致）
      win.webContents.setUserAgent(profile.userAgent)

      // 移动端启用设备模拟
      // 注意：enableDeviceEmulation 在部分 Windows 系统上会导致进程崩溃，
      // 改为通过 mobile UA + 窗口尺寸模拟移动端，足够让 AI 平台返回移动版页面。
      // this.applyDeviceEmulation(win.webContents, profile)

      // MVP：dom-ready 后注入指纹覆盖脚本（不使用 preload 文件）
      // 每次 dom-ready 重新读取最新 Profile，保证 switchUA/switchDevice 后
      // reload 触发的注入使用更新后的配置（UA / 指纹）
      win.webContents.on('dom-ready', () => {
        try {
          const currentProfile = profileStore.get(profileId)
          if (!currentProfile) return
          const script = this.fingerprintEngine.generateScript(currentProfile)
          void win.webContents.executeJavaScript(script).catch((e: unknown) => {
            console.error('[WindowManager] executeJavaScript 执行失败:', e)
          })
        } catch (err) {
          console.error('[WindowManager] 注入指纹脚本失败:', err)
        }
      })

      // 窗口关闭时清理引用
      win.on('closed', () => {
        this.windows.delete(profileId)
        this.clientHints.delete(profileId)
      })

      // 加载 URL：AI 平台用 aiPlatformUrl，普通 Profile 用内置欢迎页
      const url =
        profile.isAIPlatform && profile.aiPlatformUrl
          ? profile.aiPlatformUrl
          : this.buildWelcomePageUrl(profile)
      await win.loadURL(url)
    } catch (err) {
      console.error(`[WindowManager] 打开 Profile 失败 (${profileId}):`, err)
      throw new Error(
        `打开 Profile 失败: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /** 关闭指定 Profile 窗口 */
  async closeProfile(profileId: string): Promise<void> {
    try {
      const win = this.windows.get(profileId)
      if (!win || win.isDestroyed()) {
        this.windows.delete(profileId)
        this.clientHints.delete(profileId)
        return
      }
      win.close() // 触发 'closed' 事件自动清理引用
    } catch (err) {
      console.error(`[WindowManager] 关闭 Profile 窗口失败 (${profileId}):`, err)
      throw new Error(
        `关闭 Profile 窗口失败: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /** 关闭所有 Profile 窗口 */
  async closeAll(): Promise<void> {
    try {
      const ids = [...this.windows.keys()]
      await Promise.all(ids.map((id) => this.closeProfile(id)))
    } catch (err) {
      console.error('[WindowManager] 关闭所有窗口失败:', err)
      throw new Error(
        `关闭所有窗口失败: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * 运行时切换 UA（不重建窗口）
   * - 更新 session + webContents UA
   * - 重算并更新 Client Hints 拦截器
   * - 刷新页面使新 UA 生效
   */
  switchUA(profileId: string, ua: string): void {
    try {
      const win = this.windows.get(profileId)
      if (!win || win.isDestroyed()) {
        throw new Error(`窗口未打开: ${profileId}`)
      }

      const partition = `persist:${profileId}`
      const ses = session.fromPartition(partition)

      // 更新 session + webContents UA
      ses.setUserAgent(ua)
      win.webContents.setUserAgent(ua)

      // 重算 Client Hints（基于新 UA 推导）
      const profile = profileStore.get(profileId)
      if (profile) {
        const updatedProfile: Profile = { ...profile, userAgent: ua }
        this.clientHints.set(profileId, buildClientHints(updatedProfile))
        // 持久化 UA 变更
        profileStore.update(profileId, { userAgent: ua })
      }

      // 刷新页面使新 UA + Client Hints 生效
      win.webContents.reload()
    } catch (err) {
      console.error(`[WindowManager] 切换 UA 失败 (${profileId}):`, err)
      throw new Error(
        `切换 UA 失败: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * 切换设备预设
   * - 读取预设，更新 UA + viewport + DPR + 平台 + 设备模拟
   * - 同步 Client Hints
   */
  switchDevice(profileId: string, presetId: string): void {
    try {
      const preset = getPreset(presetId)
      if (!preset) {
        throw new Error(`设备预设不存在: ${presetId}`)
      }

      const win = this.windows.get(profileId)
      if (!win || win.isDestroyed()) {
        throw new Error(`窗口未打开: ${profileId}`)
      }

      const partition = `persist:${profileId}`
      const ses = session.fromPartition(partition)

      // 更新 session + webContents UA
      ses.setUserAgent(preset.userAgent)
      win.webContents.setUserAgent(preset.userAgent)

      // 构造临时 Profile 计算新 Client Hints + 设备模拟
      const profile = profileStore.get(profileId)
      if (profile) {
        const updatedProfile: Profile = {
          ...profile,
          devicePreset: presetId,
          userAgent: preset.userAgent,
          platform: preset.platform,
          viewport: preset.viewport,
          devicePixelRatio: preset.devicePixelRatio,
        }
        this.clientHints.set(profileId, buildClientHints(updatedProfile))

        // 更新设备模拟（已禁用：enableDeviceEmulation 在部分 Windows 上崩溃）

        // 持久化设备变更
        profileStore.update(profileId, {
          devicePreset: presetId,
          userAgent: preset.userAgent,
          platform: preset.platform,
          viewport: preset.viewport,
          devicePixelRatio: preset.devicePixelRatio,
          language: preset.language,
          timezone: preset.timezone,
        })
      }

      // 刷新页面
      win.webContents.reload()
    } catch (err) {
      console.error(`[WindowManager] 切换设备预设失败 (${profileId}):`, err)
      throw new Error(
        `切换设备预设失败: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /** 设置窗口置顶（最大化/全屏时不允许开启，冲突关系） */
  setAlwaysOnTop(profileId: string, onTop: boolean): void {
    try {
      const win = this.windows.get(profileId)
      if (!win || win.isDestroyed()) {
        throw new Error(`窗口未打开: ${profileId}`)
      }
      // 最大化/全屏与置顶互斥
      if (onTop && (win.isMaximized() || win.isFullScreen())) {
        console.log(`[WindowManager] 跳过置顶：窗口 ${profileId} 处于最大化/全屏状态`)
        return
      }
      win.setAlwaysOnTop(onTop)
      // 持久化
      profileStore.update(profileId, { alwaysOnTop: onTop })
    } catch (err) {
      console.error(`[WindowManager] 设置置顶失败 (${profileId}):`, err)
      throw new Error(
        `设置置顶失败: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /** 返回所有已打开窗口的 profileId 列表 */
  getOpenWindowIds(): string[] {
    const ids: string[] = []
    for (const [id, win] of this.windows) {
      if (!win.isDestroyed()) {
        ids.push(id)
      }
    }
    return ids
  }

  /**
   * 为嵌入式 webview 准备 session（单页架构专用）。
   * session 级 UA + 代理 + Client Hints 拦截器见 ../session.ts。
   */
  async setupSession(profileId: string): Promise<void> {
    return setupSession(profileId, this.clientHints)
  }

  /**
   * 为浏览器窗口准备独立 session（persist:${profileId}-browser）。
   * Cookie 复制 / 桌面端 UA / region 代理见 ../session.ts。
   */
  async setupBrowserSession(profileId: string): Promise<void> {
    return setupBrowserSession(profileId, this.clientHints)
  }

  // ------------------------------------------------------------------------
  // 私有辅助方法
  // ------------------------------------------------------------------------

  /**
   * 生成内置欢迎页 URL（data URI）
   * 非 AI 平台 Profile 打开时显示，提示用户当前 Profile 的指纹与设备信息，
   * 避免空白页。页面极简，无外部依赖，加载零延迟。
   */
  private buildWelcomePageUrl(profile: Profile): string {
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${profile.name}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    background: #1f1719; color: #e8e2e3;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; padding: 24px;
  }
  .card {
    max-width: 360px; width: 100%;
    background: rgba(42,32,35,0.6); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 12px; padding: 24px; text-align: center;
  }
  .icon {
    width: 48px; height: 48px; margin: 0 auto 16px;
    background: linear-gradient(135deg, #d9462f, #f59e42);
    border-radius: 12px; display: flex; align-items: center; justify-content: center;
    color: #fff; font-weight: 800; font-size: 22px; box-shadow: 0 4px 16px rgba(217,70,47,0.4);
  }
  h1 { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
  .sub { font-size: 12px; color: #8a7d80; margin-bottom: 16px; }
  .info {
    text-align: left; font-size: 11px; font-family: "Cascadia Code", Consolas, monospace;
    background: rgba(0,0,0,0.2); border-radius: 8px; padding: 12px; line-height: 1.8;
    color: #b0a3a6;
  }
  .info b { color: #f59e42; font-weight: 500; }
  .hint { margin-top: 16px; font-size: 11px; color: #6b5e61; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">W</div>
    <h1>${profile.name}</h1>
    <div class="sub">工百窗 · Profile 已就绪</div>
    <div class="info">
      <div><b>设备预设:</b> ${profile.devicePreset}</div>
      <div><b>平台:</b> ${profile.platform}</div>
      <div><b>视口:</b> ${profile.viewport.width}×${profile.viewport.height}</div>
      <div><b>DPR:</b> ${profile.devicePixelRatio}</div>
      <div><b>语言:</b> ${profile.language}</div>
      <div><b>时区:</b> ${profile.timezone}</div>
      <div><b>指纹种子:</b> ${profile.fingerprint.seed}</div>
      <div><b>Canvas:</b> ${profile.fingerprint.canvas} · <b>WebGL:</b> ${profile.fingerprint.webgl}</div>
      <div><b>Audio:</b> ${profile.fingerprint.audio} · <b>Fonts:</b> ${profile.fingerprint.fonts}</div>
    </div>
    <div class="hint">在主窗口编辑此 Profile 后刷新即可生效</div>
  </div>
</body>
</html>`
    // encodeURIComponent 保证特殊字符安全嵌入 data URI
    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
  }

  /**
   * 应用设备模拟
   * 移动端 Profile 启用 mobile 模式（screenPosition + screenSize + DPR）。
   * 桌面端不启用设备模拟，使用窗口自然视口。
   */
  private applyDeviceEmulation(webContents: WebContents, profile: Profile): void {
    if (profile.platform === 'mobile') {
      webContents.enableDeviceEmulation({
        screenPosition: 'mobile',
        screenSize: profile.viewport,
        viewPosition: { x: 0, y: 0 },
        deviceScaleFactor: profile.devicePixelRatio,
        // viewSize 使用实际视口尺寸，避免传 0 导致渲染崩溃
        viewSize: profile.viewport,
        scale: 1,
      })
    }
    // desktop：不启用设备模拟，使用窗口自然视口
  }
}
