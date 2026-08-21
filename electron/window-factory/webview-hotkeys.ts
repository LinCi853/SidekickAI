// electron/window-factory/webview-hotkeys.ts — webview 应用内快捷键路由
//
// 从 helpers.ts 的 attachWebviewPopupInterceptor 中抽离的 before-input-event 处理器。
// F12 直接在主进程执行窗口控制；其余快捷键通过 IPC WEBVIEW_HOTKEY 转发渲染层执行。
//
// 统一在主进程拦截的原因：<webview> DOM 事件的 before-input-event 对 Alt/Ctrl 组合键
// 转发不稳定（Alt+1~9 / Ctrl+Tab 可能被系统或 guest 消费），主进程 guest webContents
// 级别的 before-input-event 是 Electron 中最可靠的拦截点。

import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import { isFrozen } from '../freeze/freeze-manager.js'
import { getRecordByWebContentsId } from '../freeze/webview-registry.js'
import { isCloudPc, forceExitCloudPc } from '../utils/cloud-pc.js'
import { tryForward } from '../utils/browser-hotkey-fallback.js'
import { isBrowserWindowContents } from './renderer-loader.js'
import { findWindowIdByWin } from './window-utils.js'
import {
  setAlwaysOnTopForWindow,
  toggleMaximizeForWindow,
} from '../ipc/window-control-ipc.js'

// ── 快捷键描述符 ──────────────────────────────────────────────────────────

interface HotkeyCtx {
  mods: string[]
  key: string
  code: string
  hasCtrl: boolean
  hasAlt: boolean
  hasShift: boolean
  hasMeta: boolean
  isBrowser: boolean
  wc: Electron.WebContents
  parentWebContents: Electron.WebContents
  win: Electron.BrowserWindow
}

interface HotkeyDef {
  /** 首选按键标识（Electron input.key 值，如 'F5', 'Tab', 'Escape'） */
  key: string
  /** 次选按键标识（匹配 key 或 keyAlt 之一即可，用于同一 action 多键位） */
  keyAlt?: string
  /** 必须按下的修饰键 */
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  meta?: boolean
  /** 字母键大小写不敏感匹配（将 key 和 input.key 均转为小写比较） */
  toLower?: boolean
  /**
   * 原始 input.code 匹配模式：
   * 'prefix' — code 以此值开头时匹配（如 'Digit' 匹配 Digit1~9, 'Numpad' 匹配 Numpad1~9）
   * 'exact'  — code 精确匹配（如 'Backquote'）
   */
  matchByCode?: 'prefix' | 'exact'
  /**
   * 浏览器窗口条件过滤：
   * 'only'   — 仅浏览器窗口生效（非浏览器窗口不匹配，按键穿透到页面）
   * 'never'  — 仅非浏览器窗口生效
   * undefined — 所有窗口通用
   */
  condition?: 'only' | 'never'
  /** 此快捷键需在 tryForward 去重后才执行（与 uiohook 兜底通道协同） */
  tryFwd?: boolean
  /** 日志消息模板（{0} 替换为按键组合） */
  log: string
  /**
   * 快捷键触发时执行的回调。
   * 返回 { action, data? } 时通过 IPC WEBVIEW_HOTKEY 转发渲染层；
   * 返回 void/undefined 时不发送 IPC（由回调内部直接处理）。
   */
  action: (ctx: HotkeyCtx) => { action: string; data?: unknown } | void
}

/** 通用快捷键（所有窗口均适用，云电脑模式除外） */
const commonHotkeys: HotkeyDef[] = [
  // F4：后退（排除 Alt 以避免与 Alt+F4 关闭窗口冲突）
  { key: 'F4', log: 'F4 → 后退', action: () => ({ action: 'navBack' }) },

  // F5：刷新当前标签
  { key: 'F5', log: 'F5 → 刷新', action: () => ({ action: 'navRefresh' }) },

  // Ctrl+Shift+R / Ctrl+F5：强制刷新（清除缓存）
  { key: 'r', ctrl: true, shift: true, toLower: true, log: 'Ctrl+Shift+R → 强制刷新', action: () => ({ action: 'forceRefresh' }) },
  { key: 'F5', ctrl: true, log: 'Ctrl+F5 → 强制刷新', action: () => ({ action: 'forceRefresh' }) },

  // F6：聚焦循环（主窗口聚焦 AI 输入框，浏览器窗口循环聚焦）
  { key: 'F6', log: 'F6 → 聚焦循环', action: () => ({ action: 'focusCycle' }) },

  // F10：切换主题（light/dark）
  { key: 'F10', log: 'F10 → 切换主题', action: () => ({ action: 'toggleTheme' }) },

  // Alt+P：冻结/恢复当前页面
  {
    key: 'p', alt: true, toLower: true, tryFwd: true,
    log: 'Alt+P → 冻结/恢复当前页面',
    action: (ctx) => {
      const record = getRecordByWebContentsId(ctx.wc.id)
      return { action: 'toggleFreeze', data: record ? { tabId: record.tabId } : undefined }
    },
  },

  // Alt+1~9：切换到第 N 个标签
  {
    key: '', alt: true, matchByCode: 'prefix',
    log: 'Alt+{0} → 切换标签 #{0}',
    action: (ctx) => {
      for (const prefix of ['Digit', 'Numpad']) {
        if (ctx.code.startsWith(prefix)) {
          const n = parseInt(ctx.code.slice(prefix.length), 10)
          if (n >= 1 && n <= 9) return { action: 'switchTab', data: { index: n - 1 } }
        }
      }
    },
  },

  // Ctrl+Tab / Ctrl+Shift+Tab：循环切换标签
  {
    key: 'Tab', ctrl: true,
    log: `Ctrl+Tab → 循环切换标签`,
    action: (ctx) => ({ action: 'cycleTab', data: { reverse: ctx.hasShift } }),
  },

  // Ctrl+T：当前窗口独立（脱离当前标签为新窗口）
  { key: 't', ctrl: true, toLower: true, log: 'Ctrl+T → 当前窗口独立', action: () => ({ action: 'detachCurrent' }) },

  // Ctrl+W：关闭当前标签
  { key: 'w', ctrl: true, toLower: true, log: 'Ctrl+W → 关闭当前标签', action: () => ({ action: 'closeTab' }) },

  // Ctrl+G：切换手柄/键盘空间导航模式
  { key: 'g', ctrl: true, toLower: true, log: 'Ctrl+G → 切换空间导航模式', action: () => ({ action: 'toggleSpatialNav' }) },

  // Ctrl+D：添加当前页面到书签
  { key: 'd', ctrl: true, toLower: true, log: 'Ctrl+D → 添加书签', action: () => ({ action: 'addBookmark' }) },

  // Ctrl+H：打开历史标签
  { key: 'h', ctrl: true, toLower: true, log: 'Ctrl+H → 打开历史', action: () => ({ action: 'openHistory' }) },

  // Ctrl+J：打开下载标签
  { key: 'j', ctrl: true, toLower: true, log: 'Ctrl+J → 打开下载', action: () => ({ action: 'openDownloads' }) },

  // Ctrl+K / Ctrl+E：聚焦地址栏并进入搜索模式
  { key: 'k', ctrl: true, toLower: true, log: `Ctrl+K → 聚焦搜索`, action: () => ({ action: 'focusSearch' }) },
  { key: 'e', ctrl: true, toLower: true, log: `Ctrl+E → 聚焦搜索`, action: () => ({ action: 'focusSearch' }) },

  // Ctrl+Shift+Del：清除浏览数据
  { key: 'Delete', ctrl: true, shift: true, log: 'Ctrl+Shift+Del → 清除浏览数据', action: () => ({ action: 'clearBrowsingData' }) },

  // Ctrl+F：页内查找
  { key: 'f', ctrl: true, toLower: true, log: 'Ctrl+F → 页内查找', action: () => ({ action: 'findInPage' }) },

  // Ctrl+P：打印当前页面
  { key: 'p', ctrl: true, toLower: true, log: 'Ctrl+P → 打印', action: () => ({ action: 'print' }) },

  // Ctrl+S：另存为当前页面（仅浏览器窗口；AI 应用窗口保留页面自身行为）
  { key: 's', ctrl: true, toLower: true, condition: 'only', log: 'Ctrl+S → 另存为当前页面', action: () => ({ action: 'savePageAs' }) },

  // Ctrl+U：查看网页源代码（仅浏览器窗口）
  { key: 'u', ctrl: true, toLower: true, condition: 'only', log: 'Ctrl+U → 查看网页源代码', action: () => ({ action: 'viewSource' }) },

  // Ctrl+= / Ctrl+- / Ctrl+0：页面缩放（仅浏览器窗口）
  {
    key: '=', keyAlt: '+', ctrl: true, toLower: true, condition: 'only',
    log: 'Ctrl+= → 页面放大', action: () => ({ action: 'zoomIn' }),
  },
  { key: '-', ctrl: true, condition: 'only', log: 'Ctrl+- → 页面缩小', action: () => ({ action: 'zoomOut' }) },
  { key: '0', ctrl: true, condition: 'only', log: 'Ctrl+0 → 重置缩放', action: () => ({ action: 'zoomReset' }) },

  // 反引号(`) 呼出快捷键说明窗口
  { key: '`', keyAlt: '~', matchByCode: 'exact', log: '` → 切换快捷键窗口', action: () => ({ action: 'openShortcuts' }) },

  // Shift+? 呼出快捷键说明窗口
  { key: '?', shift: true, log: '? → 切换快捷键窗口', action: () => ({ action: 'openShortcuts' }) },
]

/** 浏览器窗口专用快捷键（非浏览器窗口不匹配，按键穿透到页面） */
const browserHotkeys: HotkeyDef[] = [
  // Ctrl+L / Alt+D：聚焦地址栏
  { key: 'l', ctrl: true, toLower: true, log: 'Ctrl+L → 聚焦地址栏 (browser)', action: () => ({ action: 'focusAddressBar' }) },
  { key: 'd', alt: true, toLower: true, log: 'Alt+D → 聚焦地址栏 (browser)', action: () => ({ action: 'focusAddressBar' }) },

  // Ctrl+R：刷新（F5 已在通用处理）
  { key: 'r', ctrl: true, toLower: true, log: 'Ctrl+R → 刷新 (browser)', action: () => ({ action: 'navRefresh' }) },

  // Ctrl+Shift+B：切换书签栏
  { key: 'b', ctrl: true, shift: true, toLower: true, log: 'Ctrl+Shift+B → 切换书签栏 (browser)', action: () => ({ action: 'toggleBookmarkBar' }) },

  // Ctrl+Shift+T：恢复最近关闭的标签
  { key: 't', ctrl: true, shift: true, toLower: true, log: 'Ctrl+Shift+T → 恢复最近关闭标签 (browser)', action: () => ({ action: 'reopenClosed' }) },

  // Alt+Left / Alt+Right：后退 / 前进
  { key: 'ArrowLeft', alt: true, log: 'Alt+← → 后退 (browser)', action: () => ({ action: 'navBack' }) },
  { key: 'ArrowRight', alt: true, log: 'Alt+→ → 前进 (browser)', action: () => ({ action: 'navForward' }) },
]

// ── 匹配引擎 ──────────────────────────────────────────────────────────────

function matchHotkey(def: HotkeyDef, ctx: HotkeyCtx): boolean {
  // 修饰键检查（未声明的修饰键必须未按下）
  if (!!def.ctrl !== ctx.hasCtrl) return false
  if (!!def.alt !== ctx.hasAlt) return false
  if (!!def.shift !== ctx.hasShift) return false
  if (!!def.meta !== ctx.hasMeta) return false

  // 窗口类型条件过滤
  if (def.condition === 'only' && !ctx.isBrowser) return false
  if (def.condition === 'never' && ctx.isBrowser) return false

  // matchByCode 模式：按 input.code 前缀/精确匹配（用于 Alt+1~9 / 反引号等）
  if (def.matchByCode) {
    if (def.matchByCode === 'prefix') {
      const defKey = def.key || def.keyAlt || ''
      return ctx.code.startsWith(defKey) || (def.keyAlt ? ctx.code.startsWith(def.keyAlt) : false)
    }
    return ctx.code === def.key
  }

  // 标准 key 匹配
  const k = def.toLower ? def.key.toLowerCase() : def.key
  const inputKey = def.toLower ? ctx.key.toLowerCase() : ctx.key
  if (inputKey === k) return true
  if (def.keyAlt) {
    const alt = def.toLower ? def.keyAlt.toLowerCase() : def.keyAlt
    if (inputKey === alt) return true
  }

  return false
}

/** 在描述符数组中查找匹配的快捷键定义 */
function findMatch(
  defs: HotkeyDef[],
  ctx: HotkeyCtx,
): HotkeyDef | undefined {
  return defs.find((d) => matchHotkey(d, ctx))
}

// ── 主处理器 ──────────────────────────────────────────────────────────────

/**
 * 在 guest webContents 上注册 before-input-event 快捷键路由。
 *
 * @param wc 已附加的 <webview> guest webContents
 * @param parentWebContents 宿主窗口的 webContents（用于反查 BrowserWindow + 转发 IPC）
 * @param onCtrlKeyChange Ctrl 按下/释放状态回调。setWindowOpenHandler 需要在
 *   拦截 window.open 时判断 Ctrl+click 是否按下，故由调用方维护 ctrlPressed 状态。
 */
export function attachWebviewHotkeyRouter(
  wc: Electron.WebContents,
  parentWebContents: Electron.WebContents,
  onCtrlKeyChange: (pressed: boolean) => void,
): void {
  // 云电脑模式三连击 Esc 检测（每次 webview attach 独立统计）
  let escPressTimes: number[] = []
  wc.on('before-input-event', (e, input) => {
    // 跟踪 Ctrl 按下/释放状态（keyDown + keyUp 均需处理）
    // 用于 setWindowOpenHandler 内 Ctrl+click 放行判断
    if (input.key === 'Control') {
      if (input.type === 'keyDown') onCtrlKeyChange(true)
      else if (input.type === 'keyUp') onCtrlKeyChange(false)
    }
    if (input.type !== 'keyDown') return
    if (input.isAutoRepeat) return
    const win = BrowserWindow.fromWebContents(parentWebContents)
    if (!win || win.isDestroyed()) return

    const mods = input.modifiers || []
    const hasAlt = mods.includes('alt')
    const hasCtrl = mods.includes('control') || mods.includes('ctrl')
    const hasShift = mods.includes('shift')
    const hasMeta = mods.includes('meta') || mods.includes('command')
    const key = input.key
    const code = input.code
    const isBrowser = isBrowserWindowContents(parentWebContents)

    const ctx: HotkeyCtx = {
      mods, key, code, hasCtrl, hasAlt, hasShift, hasMeta,
      isBrowser, wc, parentWebContents, win,
    }

    // Ctrl+Alt+C：进入/退出云电脑模式（最高优先级，云电脑模式下同样可用——
    // 保证即使状态残留也能通过快捷键退出，避免死锁）
    if (hasCtrl && hasAlt && !hasShift && !hasMeta && key.toLowerCase() === 'c') {
      if (isBrowser && tryForward('toggleCloudPc')) {
        console.log('[hotkey] Ctrl+Alt+C → 切换云电脑模式')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'toggleCloudPc' })
      }
      return
    }

    // ===== 描述符驱动的快捷键匹配 =====

    // 优先匹配浏览器窗口专用快捷键（与通用快捷键冲突时浏览器专用优先）
    let matched = findMatch(browserHotkeys, ctx)
    if (!matched) matched = findMatch(commonHotkeys, ctx)

    if (matched) {
      const result = matched.action(ctx)
      if (result) {
        if (matched.tryFwd && !tryForward(result.action)) return
        // 替换日志模板中的 {0} 占位符（用于 Alt+N 等动态键位）
        const logKey = code.match(/^(Digit|Numpad)(\d)$/)?.[2] ?? key
        console.log(`[hotkey] ${matched.log.replace(/\{0\}/g, logKey)}`)
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, result)
      }
      return
    }

    // ===== 云电脑模式：所有按键直通远端页面（不拦截），仅保留冗余退出组合 =====
    if (isCloudPc(parentWebContents.id)) {
      // 退出组合 1：Ctrl+Alt+Shift+F12（主进程兜底，渲染层无响应也能退出）
      if (hasCtrl && hasAlt && hasShift && !hasMeta && key === 'F12') {
        console.log('[hotkey] 云电脑模式 Ctrl+Alt+Shift+F12 → 主进程兜底退出')
        e.preventDefault()
        forceExitCloudPc(win, parentWebContents.id)
        return
      }
      // 退出组合 2：三连击 Esc（1 秒内连续按三次；前两次放行给远端页面，
      // 第三次触发退出——避免远端双击 Esc 取消对话框被误退，保底可靠）
      if (key === 'Escape' && !hasCtrl && !hasAlt && !hasShift && !hasMeta) {
        const now = Date.now()
        // 保留最近三次按下时间戳
        escPressTimes.push(now)
        if (escPressTimes.length > 3) escPressTimes.shift()
        if (escPressTimes.length === 3 && now - escPressTimes[0] < 1000) {
          console.log('[hotkey] 云电脑模式三连击 Esc → 主进程兜底退出')
          e.preventDefault()
          escPressTimes = []
          forceExitCloudPc(win, parentWebContents.id)
        } else if (now - (escPressTimes[escPressTimes.length - 2] ?? 0) > 1000) {
          // 间隔过长重置计数
          escPressTimes = [now]
        }
        return
      }
      // 其余按键（含 F5/F11/Ctrl+W/Ctrl+T 等）：完全放行给远端页面
      return
    }

    // ===== F11/F12/Escape：含窗口类型分支的特殊快捷键 =====

    // F11：切换全屏/最大化（按窗口类型区分）
    // - 浏览器窗口：切换原生全屏（沉浸式全屏，渲染层收到状态后隐藏标签/导航/书签栏）
    // - 其他窗口：切换最大化/还原（接入 WindowMaximizeManager）
    if (key === 'F11' && !hasCtrl && !hasAlt && !hasShift) {
      if (isBrowser && tryForward('toggleFullscreen')) {
        console.log('[hotkey] F11 → 浏览器窗口切换沉浸式全屏')
        e.preventDefault()
        try { win.setFullScreen(!win.isFullScreen()) }
        catch (err) { console.error('[hotkey] 切换全屏失败:', err) }
        return
      }
      console.log('[hotkey] F11 → 切换最大化')
      e.preventDefault()
      toggleMaximizeForWindow(win, findWindowIdByWin(win))
      return
    }

    // Escape：浏览器窗口全屏时退出全屏（沉浸式全屏的标准退出方式）
    if (key === 'Escape' && !hasCtrl && !hasAlt && !hasShift) {
      if (isBrowser && win.isFullScreen()) {
        console.log('[hotkey] Escape → 退出浏览器窗口全屏')
        e.preventDefault()
        try { win.setFullScreen(false) } catch { /* ignore */ }
        return
      }
    }

    // F12：浏览器窗口中切换 DevTools，其他窗口置顶/取消置顶
    if (key === 'F12' && !hasCtrl) {
      // 冻结期间短路 F12：debugger 已占用，开 DevTools 会冲突
      const wcId = wc.id
      if (wcId !== undefined) {
        const rec = getRecordByWebContentsId(wcId)
        if (rec && isFrozen(rec.tabId)) {
          console.log('[hotkey] F12 跳过：该 webview 处于冻结态')
          e.preventDefault()
          return
        }
      }

      if (isBrowser) {
        console.log('[hotkey] F12 → DevTools 切换 (browser window)')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.BROWSER_TOGGLE_DEVTOOLS)
        return
      }

      // 非浏览器窗口：置顶/取消置顶
      console.log('[hotkey] F12 → 置顶切换')
      e.preventDefault()
      // 最大化/全屏与置顶互斥：先退出最大化/全屏，再切换置顶
      if (win.isMaximized()) {
        win.unmaximize()
        parentWebContents.send(IPC_CHANNELS.WIN_CONTROL_MAXIMIZE_TOGGLED, false)
      }
      if (win.isFullScreen()) {
        win.setFullScreen(false)
      }
      const windowId = findWindowIdByWin(win)
      const next = !win.isAlwaysOnTop()
      const actual = setAlwaysOnTopForWindow(win, windowId, next)
      parentWebContents.send(IPC_CHANNELS.WIN_CONTROL_PIN_TOGGLED, actual)
      return
    }
  })
}
