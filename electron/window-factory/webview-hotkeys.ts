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
    // 需求 8：跟踪 Ctrl 按下/释放状态（keyDown + keyUp 均需处理）
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

    // Ctrl+Alt+C：进入/退出云电脑模式（最高优先级，云电脑模式下同样可用——
    // 保证即使状态残留也能通过快捷键退出，避免死锁）
    if (hasCtrl && hasAlt && !hasShift && !hasMeta && key.toLowerCase() === 'c') {
      const isBrowserWin = isBrowserWindowContents(parentWebContents)
      if (isBrowserWin && tryForward('toggleCloudPc')) {
        console.log('[hotkey] Ctrl+Alt+C → 切换云电脑模式')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'toggleCloudPc' })
      }
      return
    }

    // ===== 浏览器窗口 webview 焦点时的导航/标签快捷键转发（与渲染层 defs 的 action 对应） =====
    const isBrowserWin = isBrowserWindowContents(parentWebContents)
    if (isBrowserWin) {
      // Ctrl+L / Alt+D：聚焦地址栏
      if ((hasCtrl && !hasShift && !hasAlt && key.toLowerCase() === 'l')
        || (hasAlt && !hasCtrl && !hasShift && key.toLowerCase() === 'd')) {
        console.log('[hotkey] Ctrl+L/Alt+D → 聚焦地址栏 (browser)')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'focusAddressBar' })
        return
      }
      // Ctrl+R：刷新（F5 已在下方通用处理）
      if (hasCtrl && !hasShift && !hasAlt && key.toLowerCase() === 'r') {
        console.log('[hotkey] Ctrl+R → 刷新 (browser)')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'navRefresh' })
        return
      }
      // Ctrl+Shift+B：切换书签栏
      if (hasCtrl && hasShift && !hasAlt && key.toLowerCase() === 'b') {
        console.log('[hotkey] Ctrl+Shift+B → 切换书签栏 (browser)')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'toggleBookmarkBar' })
        return
      }
      // Ctrl+Shift+T：恢复最近关闭的标签
      if (hasCtrl && hasShift && !hasAlt && key.toLowerCase() === 't') {
        console.log('[hotkey] Ctrl+Shift+T → 恢复最近关闭标签 (browser)')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'reopenClosed' })
        return
      }
      // Alt+Left / Alt+Right：后退 / 前进
      if (hasAlt && !hasCtrl && !hasShift && (key === 'ArrowLeft' || key === 'ArrowRight')) {
        console.log('[hotkey] Alt+方向键 → 后退/前进 (browser)')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: key === 'ArrowLeft' ? 'navBack' : 'navForward' })
        return
      }
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


    // F4：后退（排除 Alt 以避免与 Alt+F4 关闭窗口冲突）
    if (key === 'F4' && !hasCtrl && !hasAlt) {
      console.log('[hotkey] F4 → 后退')
      e.preventDefault()
      parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'navBack' })
      return
    }

    // Ctrl+Shift+R 或 Ctrl+F5：强制刷新（清除缓存）
    if (
      !hasAlt &&
      ((hasCtrl && hasShift && key.toLowerCase() === 'r') || (hasCtrl && key === 'F5'))
    ) {
      console.log('[hotkey] Ctrl+Shift+R/Ctrl+F5 → 强制刷新')
      e.preventDefault()
      parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'forceRefresh' })
      return
    }

    // F5：刷新当前标签
    if (key === 'F5' && !hasCtrl && !hasAlt) {
      console.log('[hotkey] F5 → 刷新')
      e.preventDefault()
      parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'navRefresh' })
      return
    }

    // F6：通过 IPC 转发到渲染层处理（主窗口聚焦 AI 输入框，浏览器窗口循环聚焦）
    if (key === 'F6' && !hasCtrl && !hasAlt && !hasShift) {
      console.log('[hotkey] F6 → 聚焦循环')
      e.preventDefault()
      parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'focusCycle' })
      return
    }

    // F10：切换主题（light/dark）
    if (key === 'F10' && !hasCtrl && !hasAlt && !hasShift) {
      console.log('[hotkey] F10 → 切换主题')
      e.preventDefault()
      parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'toggleTheme' })
      return
    }

    // F11：切换全屏/最大化（按窗口类型区分）
    // - 浏览器窗口：切换原生全屏（沉浸式全屏，渲染层收到状态后隐藏标签/导航/书签栏）
    // - 其他窗口：切换最大化/还原（接入 WindowMaximizeManager）
    if (key === 'F11' && !hasCtrl && !hasAlt && !hasShift) {
      const isBrowserWin = isBrowserWindowContents(parentWebContents)
      if (isBrowserWin && tryForward('toggleFullscreen')) {
        console.log('[hotkey] F11 → 浏览器窗口切换沉浸式全屏')
        e.preventDefault()
        // enter-full-screen / leave-full-screen 事件会广播 WIN_CONTROL_FULLSCREEN_TOGGLED
        try {
          win.setFullScreen(!win.isFullScreen())
        } catch (err) {
          console.error('[hotkey] 切换全屏失败:', err)
        }
        return
      }
      console.log('[hotkey] F11 → 切换最大化')
      e.preventDefault()
      const winId = findWindowIdByWin(win)
      toggleMaximizeForWindow(win, winId)
      return
    }

    // Escape：浏览器窗口全屏时退出全屏（沉浸式全屏的标准退出方式）
    if (key === 'Escape' && !hasCtrl && !hasAlt && !hasShift) {
      if (isBrowserWindowContents(parentWebContents) && win.isFullScreen()) {
        console.log('[hotkey] Escape → 退出浏览器窗口全屏')
        e.preventDefault()
        try {
          win.setFullScreen(false)
        } catch { /* ignore */ }
        return
      }
    }

    // F12：浏览器窗口中切换 DevTools，其他窗口置顶/取消置顶
    if (key === 'F12' && !hasCtrl) {
      // 冻结期间短路 F12：debugger 已占用，开 DevTools 会冲突
      const wcId = wc.id
      // 按 webContentsId 反查 tabId 较重，这里用「任意冻结中」粗判即可（冻结态本就罕见）
      if (wcId !== undefined) {
        const rec = getRecordByWebContentsId(wcId)
        if (rec && isFrozen(rec.tabId)) {
          console.log('[hotkey] F12 跳过：该 webview 处于冻结态')
          e.preventDefault()
          return
        }
      }

      // 判断是否为浏览器窗口（URL 含 mode=browser）
      const isBrowserWindow = isBrowserWindowContents(parentWebContents)

      if (isBrowserWindow) {
        // 浏览器窗口：通知渲染层切换 DevTools
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
        // 手动同步渲染层最大化状态（unmaximize 事件处理器仅记日志不发 IPC）
        parentWebContents.send(IPC_CHANNELS.WIN_CONTROL_MAXIMIZE_TOGGLED, false)
      }
      if (win.isFullScreen()) {
        win.setFullScreen(false)
        // leave-full-screen 事件会自动同步渲染层全屏状态
      }
      const windowId = findWindowIdByWin(win)
      const next = !win.isAlwaysOnTop()
      const actual = setAlwaysOnTopForWindow(win, windowId, next)
      parentWebContents.send(IPC_CHANNELS.WIN_CONTROL_PIN_TOGGLED, actual)
      return
    }

    // Alt+1~9：切换到第 N 个标签（仅 Alt，无其它修饰键）
    if (hasAlt && !hasCtrl && !hasMeta && !hasShift) {
      // Alt+P：冻结/恢复当前页面（防撤回保险，浏览器窗口专用）
      if (key.toLowerCase() === 'p') {
        // 与 uiohook 兜底通道去重（同一 action 250ms 内仅一条生效）
        if (tryForward('toggleFreeze')) {
          console.log('[hotkey] Alt+P → 冻结/恢复当前页面')
          e.preventDefault()
          const record = getRecordByWebContentsId(wc.id)
          parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, {
            action: 'toggleFreeze',
            data: record ? { tabId: record.tabId } : undefined,
          })
        }
        return
      }
      let n: number | null = null
      if (code.startsWith('Digit')) {
        const parsed = parseInt(code.slice('Digit'.length), 10)
        if (parsed >= 1 && parsed <= 9) n = parsed
      } else if (code.startsWith('Numpad')) {
        const parsed = parseInt(code.slice('Numpad'.length), 10)
        if (parsed >= 1 && parsed <= 9) n = parsed
      }
      if (n != null) {
        console.log(`[hotkey] Alt+${n} → 切换标签 #${n}`)
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'switchTab', data: { index: n - 1 } })
        return
      }
    }

    // Ctrl+Tab / Ctrl+Shift+Tab：循环切换标签
    if (hasCtrl && key === 'Tab') {
      console.log(`[hotkey] Ctrl+Tab${hasShift ? '+Shift' : ''} → 循环切换标签(${hasShift ? '反向' : '正向'})`)
      e.preventDefault()
      parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'cycleTab', data: { reverse: hasShift } })
      return
    }

    // Ctrl+T：当前窗口独立（脱离当前标签为新窗口）
    if (hasCtrl && !hasShift && !hasAlt && !hasMeta && key.toLowerCase() === 't') {
      console.log('[hotkey] Ctrl+T → 当前窗口独立（detachCurrent）')
      e.preventDefault()
      parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'detachCurrent' })
      return
    }

    // Ctrl+W：关闭当前标签（无标签时不操作，不关闭窗口）
    if (hasCtrl && !hasShift && !hasAlt && !hasMeta && key.toLowerCase() === 'w') {
      console.log('[hotkey] Ctrl+W → 关闭当前标签')
      e.preventDefault()
      parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'closeTab' })
      return
    }

    // Ctrl+G：切换手柄/键盘空间导航模式
    if (hasCtrl && !hasAlt && !hasShift && key.toLowerCase() === 'g') {
      console.log('[hotkey] Ctrl+G → 切换空间导航模式')
      e.preventDefault()
      parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'toggleSpatialNav' })
      return
    }

    // Ctrl+D：添加当前页面到书签
    if (hasCtrl && !hasShift && !hasAlt && !hasMeta && key.toLowerCase() === 'd') {
      console.log('[hotkey] Ctrl+D → 添加书签')
      e.preventDefault()
      parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'addBookmark' })
      return
    }

    // Ctrl+H：打开历史标签
    if (hasCtrl && !hasShift && !hasAlt && !hasMeta && key.toLowerCase() === 'h') {
      console.log('[hotkey] Ctrl+H → 打开历史')
      e.preventDefault()
      parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'openHistory' })
      return
    }

    // Ctrl+J：打开下载标签
    if (hasCtrl && !hasShift && !hasAlt && !hasMeta && key.toLowerCase() === 'j') {
      console.log('[hotkey] Ctrl+J → 打开下载')
      e.preventDefault()
      parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'openDownloads' })
      return
    }

    // Ctrl+K / Ctrl+E：聚焦地址栏并进入搜索模式
    if (hasCtrl && !hasShift && !hasAlt && !hasMeta && (key.toLowerCase() === 'k' || key.toLowerCase() === 'e')) {
      console.log(`[hotkey] Ctrl+${key.toUpperCase()} → 聚焦搜索`)
      e.preventDefault()
      parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'focusSearch' })
      return
    }

    // Ctrl+Shift+Del：清除浏览数据
    if (hasCtrl && hasShift && !hasAlt && !hasMeta && key === 'Delete') {
      console.log('[hotkey] Ctrl+Shift+Del → 清除浏览数据')
      e.preventDefault()
      parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'clearBrowsingData' })
      return
    }

    // Ctrl+F：页内查找
    if (hasCtrl && !hasShift && !hasAlt && !hasMeta && key.toLowerCase() === 'f') {
      console.log('[hotkey] Ctrl+F → 页内查找')
      e.preventDefault()
      parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'findInPage' })
      return
    }

    // Ctrl+P：打印当前页面
    if (hasCtrl && !hasShift && !hasAlt && !hasMeta && key.toLowerCase() === 'p') {
      console.log('[hotkey] Ctrl+P → 打印')
      e.preventDefault()
      parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'print' })
      return
    }

    // Ctrl+S：另存为当前页面（仅浏览器窗口；AI 应用窗口保留页面自身行为）
    if (hasCtrl && !hasShift && !hasAlt && !hasMeta && key.toLowerCase() === 's') {
      const isBrowserWin = isBrowserWindowContents(parentWebContents)
      if (isBrowserWin) {
        console.log('[hotkey] Ctrl+S → 另存为当前页面')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'savePageAs' })
      }
      return
    }

    // Ctrl+U：查看网页源代码（仅浏览器窗口）
    if (hasCtrl && !hasShift && !hasAlt && !hasMeta && key.toLowerCase() === 'u') {
      const isBrowserWin = isBrowserWindowContents(parentWebContents)
      if (isBrowserWin) {
        console.log('[hotkey] Ctrl+U → 查看网页源代码')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'viewSource' })
      }
      return
    }

    // Ctrl+= / Ctrl+- / Ctrl+0：页面缩放（仅浏览器窗口）
    if (hasCtrl && !hasShift && !hasAlt && !hasMeta && (key === '=' || key === '+' || key === '-' || key === '0')) {
      const isBrowserWin = isBrowserWindowContents(parentWebContents)
      if (isBrowserWin) {
        e.preventDefault()
        if (key === '-') {
          parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'zoomOut' })
        } else if (key === '0') {
          parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'zoomReset' })
        } else {
          parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'zoomIn' })
        }
      }
      return
    }

    // 反引号(` ~) 或 Shift+? 呼出快捷键说明窗口
    if (!hasAlt && !hasCtrl && !hasMeta && !hasShift && (key === '`' || key === '~' || code === 'Backquote')) {
      console.log('[hotkey] ` → 切换快捷键窗口')
      e.preventDefault()
      parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'openShortcuts' })
      return
    }
    if (!hasAlt && !hasCtrl && !hasMeta && hasShift && key === '?') {
      console.log('[hotkey] ? → 切换快捷键窗口')
      e.preventDefault()
      parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'openShortcuts' })
      return
    }
  })
}
