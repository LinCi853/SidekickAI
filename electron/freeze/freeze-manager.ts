// electron/freeze/freeze-manager.ts — 页面冻结管理器（Debugger.pause 彻底定格 + 智能解冻交互）
//
// 防撤回保险的核心：对 webview 的 guest webContents 执行 Debugger.pause，
// 锁死 JS 主线程（定时器/rAF/事件/SSE 回调全部停止），页面画面彻底定格。
//
// 冻结策略演进（scripts/freeze-poc-*.cjs 逐轮验证）：
//   v1 Debugger.pause 单层 —— 有效，但「冻结后加载提示还在动」？
//       → 排查发现是 CSS compositor 动画不受 JS 暂停影响。
//   v2 + Emulation.setVirtualTimePolicy(pause) 双层 —— 无网络页面全定格；但真实
//       AI 页面有活跃 SSE 连接时消息会唤醒虚拟时间，动画照转内容照更新 → 移除。
//   v3 纯 Debugger.pause —— 画面彻底定格，滚轮滚动可用（compositor 层）。
//   v4 智能解冻点击 —— before-input-event 监听 mouseDown 触发解冻。实测失败：
//       Electron 的 before-input-event 只保证 keydown/keyup（鼠标不触发），
//       宿主 DOM 也收不到路由到 guest 的真实鼠标事件（POC 逐项证伪）。
//   v5 应用内置复制 —— 冻结态 Ctrl+C（before-input-event 键盘，实测触发 ✓）：
//       主进程读选中文本写剪贴板，与网页无关。
//   v6 uiohook 系统级鼠标钩子（当前）—— uiohook（libuiohook）是系统级钩子，
//       与 Electron 渲染无关、冻结不影响（POC 实测 mousedown/mouseup 事件收到）。
//       坐标不直接用 uiohook（DPI 缩放差异），仅作触发器，命中判断取
//       screen.getCursorScreenPoint()（与窗口 bounds 同坐标系）。
//       webview 屏幕区域 = 窗口 bounds + 渲染层上报的 rect（FREEZE_TAB/窗口
//       move/resize 时同步）。命中后 resume → 补发 mouseDown → 拖拽选中 →
//       mouseUp（或 5s 超时）→ 缓冲后重新 pause。
//
// 已知边界（用户已确认取舍）：
//   - 解冻窗口内（拖拽/点击期间）积压的 SSE 推送会被一次性处理（内容可能快速
//     跳变到最新，然后重新定格）；防撤回数据保险依赖冻结前已入库的快照
//   - 文本选中后的 Ctrl+C 由应用内置复制完成（v5），与网页无关

import { clipboard, screen, type BrowserWindow, type Input, type WebContents } from 'electron'
import { createRequire } from 'node:module'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import { getWebviewByTabId, listRegisteredWebviews } from './webview-registry.js'

/** 冻结状态 */
export type FreezeState = 'idle' | 'attached' | 'frozen'

/** 单个 webContents 的冻结会话 */
interface FreezeSession {
  webContentsId: number
  state: FreezeState
  /** attach 时间戳 */
  attachedAt: number
  /** pause 时间戳（未冻结为 null） */
  frozenAt: number | null
  /** 智能解冻窗口进行中（避免重复进入） */
  unfreezing?: boolean
  /** webview 在窗口内的边界（物理像素）+ dpr（uiohook 命中检测用） */
  rect?: { x: number; y: number; width: number; height: number; dpr: number }
  /** mouseUp 时结束解冻窗口的回调（uiohook 触发） */
  unfreezeFinish?: () => void
  /** 冻结态 Ctrl+C 应用内置复制的键盘监听（detach 时移除） */
  keyboardHandler?: (event: Electron.Event, input: Input) => void
}

/** tabId → 冻结会话 */
const sessions = new Map<string, FreezeSession>()

/**
 * 获取 guest webContents 所属窗口。
 * webContents.getOwnerBrowserWindow 运行时存在（POC 验证）但 Electron 30 类型
 * 定义缺失，用类型断言访问。
 */
function getOwnerWindow(wc: WebContents): BrowserWindow | null {
  const fn = (wc as unknown as { getOwnerBrowserWindow?: () => BrowserWindow | null }).getOwnerBrowserWindow
  return typeof fn === 'function' ? (fn.call(wc) ?? null) : null
}

/** 附加调试器并启用递归子目标 attach（不 pause） */
async function attach(wc: WebContents): Promise<void> {
  if (wc.debugger.isAttached()) return
  await wc.debugger.attach('1.3')
  await wc.debugger.sendCommand('Debugger.enable')
  // 递归 attach 子目标（iframe / Worker / Service Worker），否则冻结不彻底
  await wc.debugger.sendCommand('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  })
}

/** 智能解冻窗口参数 */
const UNFREEZE_TIMEOUT_MS = 5000 // 解冻窗口上限（拖拽选中大段文本可能需要数秒）
const CLICK_SETTLE_MS = 200 // mouseUp 后留给 click 事件与 JS 同步响应的缓冲
const COPY_SETTLE_MS = 300 // Ctrl+C 复制后留给剪贴板写入的缓冲

// ==================== uiohook 系统级鼠标钩子 ====================
// 触发链：冻结态页面收不到鼠标事件（before-input-event 只保证键盘、宿主 DOM
// 收不到路由到 guest 的事件——POC 逐项证伪），改用 uiohook 系统级钩子检测
// 真实鼠标按下/松开（与 Electron 渲染无关，冻结不影响）。
// 坐标不采用 uiohook（存在 DPI 缩放差异），仅作触发器，命中判断取
// screen.getCursorScreenPoint()（与窗口 bounds 同坐标系）。

interface UiohookMouseModule {
  uIOhook: {
    start(): void
    stop(): void
    on(event: string, cb: () => void): void
  }
}

let mouseHookInstalled = false

/** 安装 uiohook 鼠标钩子（全局单例，幂等）。不重复 start（HotkeyManager 可能已启动）。 */
function ensureMouseHook(): void {
  if (mouseHookInstalled) return
  mouseHookInstalled = true
  try {
    const require = createRequire(import.meta.url)
    const mod = require('uiohook-napi') as UiohookMouseModule
    const uio = mod.uIOhook
    try {
      uio.start()
    } catch {
      /* 可能已由 HotkeyManager 启动 */
    }
    uio.on('mousedown', () => handleGlobalMouseDown())
    uio.on('mouseup', () => handleGlobalMouseUp())
    console.log('[freeze] uiohook 鼠标钩子已安装（冻结态点击/拖拽检测）')
  } catch (err) {
    console.warn('[freeze] uiohook 加载失败，冻结态点击/拖拽不可用:', err)
  }
}

/** 命中检测：屏幕坐标是否落在某冻结 tab 的 webview 区域内 */
function findFrozenTabAt(
  sx: number,
  sy: number,
): { tabId: string; wc: WebContents; session: FreezeSession; localX: number; localY: number } | null {
  for (const [tabId, s] of sessions) {
    if (s.state !== 'frozen' || s.unfreezing || !s.rect) continue
    const wc = getWebviewByTabId(tabId)
    if (!wc || wc.isDestroyed()) continue
    const win = getOwnerWindow(wc)
    if (!win || win.isDestroyed()) continue
    const wb = win.getBounds()
    const r = s.rect
    const absX = wb.x + r.x
    const absY = wb.y + r.y
    if (sx >= absX && sx <= absX + r.width && sy >= absY && sy <= absY + r.height) {
      return { tabId, wc, session: s, localX: (sx - absX) / r.dpr, localY: (sy - absY) / r.dpr }
    }
  }
  return null
}

/** 全局鼠标按下：命中冻结 tab → 瞬时解冻 + 补发 mouseDown（开始点击/拖拽选中） */
function handleGlobalMouseDown(): void {
  const p = screen.getCursorScreenPoint()
  const hit = findFrozenTabAt(p.x, p.y)
  if (!hit) return
  const { tabId, wc, session, localX, localY } = hit
  console.log(`[freeze] tab ${tabId} 冻结态检测到鼠标按下 (${Math.round(localX)},${Math.round(localY)})，瞬时解冻`)
  session.unfreezing = true

  let finished = false
  const refreeze = () => {
    if (finished) return
    finished = true
    void (async () => {
      // 缓冲：让 click 合成 + JS 同步响应执行完
      await new Promise((r) => setTimeout(r, CLICK_SETTLE_MS))
      try {
        if (!wc.isDestroyed() && wc.debugger.isAttached()) {
          await wc.debugger.sendCommand('Debugger.pause')
          console.log(`[freeze] tab ${tabId} 交互已执行，重新冻结`)
        }
      } catch {
        /* ignore */
      }
      session.unfreezing = false
      session.unfreezeFinish = undefined
    })()
  }
  session.unfreezeFinish = refreeze

  void (async () => {
    try {
      await wc.debugger.sendCommand('Debugger.resume')
    } catch (err) {
      console.warn(`[freeze] tab ${tabId} 瞬时解冻失败:`, err)
      session.unfreezing = false
      session.unfreezeFinish = undefined
      return
    }
    // 补发 mouseDown：冻结期间按下的事件已丢失，解冻后需补发才能开始选择
    try {
      wc.sendInputEvent({
        type: 'mouseDown',
        x: Math.round(localX),
        y: Math.round(localY),
        button: 'left',
        clickCount: 1,
      })
    } catch {
      /* ignore */
    }
    // 超时兜底：mouseUp 事件丢失时强制重新冻结
    setTimeout(refreeze, UNFREEZE_TIMEOUT_MS)
  })()
}

/** 全局鼠标松开：结束进行中的解冻窗口 */
function handleGlobalMouseUp(): void {
  for (const s of sessions.values()) {
    if (s.state === 'frozen' && s.unfreezing && s.unfreezeFinish) {
      s.unfreezeFinish()
    }
  }
}

// ==================== webview 区域 rect 同步 ====================

/** 已绑定 move/resize 同步监听的窗口（幂等） */
const windowRectSyncSet = new Set<number>()

/** 窗口移动/缩放时请求渲染层重新上报冻结 tab 的 webview rect */
function ensureWindowRectSync(win: BrowserWindow): void {
  if (windowRectSyncSet.has(win.id)) return
  windowRectSyncSet.add(win.id)
  const sync = () => {
    const tabIds: string[] = []
    for (const [tabId, s] of sessions) {
      if (s.state !== 'frozen') continue
      const wc = getWebviewByTabId(tabId)
      if (wc && !wc.isDestroyed() && getOwnerWindow(wc)?.id === win.id) tabIds.push(tabId)
    }
    if (tabIds.length && !win.isDestroyed()) {
      try {
        win.webContents.send(IPC_CHANNELS.FREEZE_SYNC_RECT, { tabIds })
      } catch {
        /* ignore */
      }
    }
  }
  win.on('move', sync)
  win.on('resize', sync)
}

/** 渲染层上报 webview 位置（窗口内物理像素 + dpr），供 uiohook 命中检测 */
export function updateSessionRect(
  tabId: string,
  rect: { x: number; y: number; width: number; height: number; dpr: number },
): void {
  const s = sessions.get(tabId)
  if (s) s.rect = rect
}

// ==================== 应用内置复制（Ctrl+C，键盘） ====================

/**
 * 应用内置复制：冻结态 Ctrl+C → 瞬时 resume → 主进程读取页面选中文本
 * （executeJavaScript）→ 写入系统剪贴板 → 重新 pause。
 * 全程由应用完成，与网页自身的复制逻辑/权限无关。
 */
function appCopySelection(wc: WebContents, tabId: string, session: FreezeSession): void {
  session.unfreezing = true
  void (async () => {
    try {
      await wc.debugger.sendCommand('Debugger.resume')
      // 等 JS 恢复后读取选中文本
      await new Promise((r) => setTimeout(r, 80))
      const sel = (await wc.executeJavaScript('window.getSelection()?.toString() ?? ""').catch(() => '')) as string
      if (sel) {
        clipboard.writeText(sel)
        console.log(`[freeze] tab ${tabId} 应用内置复制: ${sel.length} 字符已入剪贴板`)
      } else {
        console.log(`[freeze] tab ${tabId} 复制: 无选中文本`)
      }
    } catch (err) {
      console.warn(`[freeze] tab ${tabId} 应用内置复制失败:`, err)
    } finally {
      await new Promise((r) => setTimeout(r, COPY_SETTLE_MS))
      try {
        if (!wc.isDestroyed() && wc.debugger.isAttached()) {
          await wc.debugger.sendCommand('Debugger.pause')
        }
      } catch {
        /* ignore */
      }
      session.unfreezing = false
    }
  })()
}

/** 安装冻结态键盘监听（Ctrl+C 应用内置复制；before-input-event 只保证键盘事件） */
function installFreezeKeyboardHook(wc: WebContents, tabId: string, session: FreezeSession): void {
  // 先移除旧的（幂等）
  if (session.keyboardHandler && !wc.isDestroyed()) {
    wc.removeListener('before-input-event', session.keyboardHandler)
    session.keyboardHandler = undefined
  }
  const handler = (event: Electron.Event, input: Input) => {
    if (
      input.type === 'keyDown' &&
      input.control && !input.alt && !input.meta &&
      input.key?.toLowerCase() === 'c'
    ) {
      if (session.state !== 'frozen' || session.unfreezing) return
      event.preventDefault()
      console.log(`[freeze] tab ${tabId} 冻结态检测到 Ctrl+C，应用内置复制`)
      appCopySelection(wc, tabId, session)
    }
  }
  wc.on('before-input-event', handler)
  session.keyboardHandler = handler
}

/** 移除冻结态键盘监听 */
function removeFreezeKeyboardHook(wc: WebContents, session: FreezeSession): void {
  if (session.keyboardHandler && !wc.isDestroyed()) {
    wc.removeListener('before-input-event', session.keyboardHandler)
  }
  session.keyboardHandler = undefined
}

// ==================== 冻结 / 恢复 / 分离 ====================

/**
 * 冻结指定 tabId 的 webview。
 *
 * 注意：调用方应在调用此方法**之前**完成对话抓取（executeJavaScript 读取 DOM），
 * 因为冻结后 executeJavaScript 会 hang。
 *
 * @returns 是否成功冻结
 */
export async function freezeTab(tabId: string): Promise<boolean> {
  const wc = getWebviewByTabId(tabId)
  if (!wc) {
    console.warn(`[freeze] tab ${tabId} 的 webview 未找到（注册表: ${listRegisteredWebviews().length} 条）`)
    return false
  }

  const existing = sessions.get(tabId)
  try {
    if (!existing || existing.state === 'idle') {
      await attach(wc)
      // 彻底定格：Debugger.pause 锁死 JS（动画/定时器/SSE 回调全停，画面定格）
      await wc.debugger.sendCommand('Debugger.pause')
      const session: FreezeSession = {
        webContentsId: wc.id,
        state: 'frozen',
        attachedAt: existing?.attachedAt ?? Date.now(),
        frozenAt: Date.now(),
      }
      sessions.set(tabId, session)
      // 冻结态交互：uiohook 鼠标钩子 + Ctrl+C 应用内置复制 + 窗口 rect 同步
      ensureMouseHook()
      installFreezeKeyboardHook(wc, tabId, session)
      const win = getOwnerWindow(wc)
      if (win && !win.isDestroyed()) ensureWindowRectSync(win)
      console.log(`[freeze] tab ${tabId} 已冻结`)
      return true
    }
    if (existing.state === 'attached') {
      // 已 attach 未冻结 → 直接 pause
      await wc.debugger.sendCommand('Debugger.pause')
      existing.state = 'frozen'
      existing.frozenAt = Date.now()
      sessions.set(tabId, existing)
      installFreezeKeyboardHook(wc, tabId, existing)
      ensureMouseHook()
      const win = getOwnerWindow(wc)
      if (win && !win.isDestroyed()) ensureWindowRectSync(win)
      console.log(`[freeze] tab ${tabId} 已冻结（复用已 attach 的 debugger）`)
      return true
    }
    // 已冻结 → 幂等返回
    console.log(`[freeze] tab ${tabId} 已处于冻结态，跳过`)
    return true
  } catch (err) {
    console.error(`[freeze] 冻结 tab ${tabId} 失败:`, err)
    return false
  }
}

/**
 * 恢复指定 tabId 的 webview（解除冻结，页面无缝继续）。
 * @returns 是否成功恢复
 */
export async function resumeTab(tabId: string): Promise<boolean> {
  const session = sessions.get(tabId)
  if (!session || session.state !== 'frozen') {
    console.log(`[freeze] tab ${tabId} 未冻结，无需恢复`)
    return false
  }
  const wc = getWebviewByTabId(tabId)
  if (!wc) {
    console.warn(`[freeze] tab ${tabId} 的 webview 已销毁，清理会话`)
    sessions.delete(tabId)
    return false
  }
  try {
    // 用户主动恢复：移除冻结态键盘监听（页面恢复完全交互）
    removeFreezeKeyboardHook(wc, session)
    session.unfreezing = false
    session.unfreezeFinish = undefined
    await wc.debugger.sendCommand('Debugger.resume')
    session.state = 'attached'
    session.frozenAt = null
    sessions.set(tabId, session)
    console.log(`[freeze] tab ${tabId} 已恢复`)
    return true
  } catch (err) {
    console.error(`[freeze] 恢复 tab ${tabId} 失败:`, err)
    return false
  }
}

/**
 * 彻底分离调试器（恢复 + detach）。
 * 用于退出冻结模式、切换标签、关闭页面时清理。
 */
export async function detachTab(tabId: string): Promise<void> {
  const session = sessions.get(tabId)
  if (!session) return
  const wc = getWebviewByTabId(tabId)
  if (wc && !wc.isDestroyed()) {
    try {
      removeFreezeKeyboardHook(wc, session)
      if (session.state === 'frozen') {
        await wc.debugger.sendCommand('Debugger.resume')
      }
      if (wc.debugger.isAttached()) {
        await wc.debugger.detach()
      }
    } catch (err) {
      console.warn(`[freeze] detach tab ${tabId} 异常:`, err)
    }
  }
  sessions.delete(tabId)
  console.log(`[freeze] tab ${tabId} 已分离调试器`)
}

/** 查询指定 tab 的冻结状态 */
export function getFreezeState(tabId: string): FreezeState {
  return sessions.get(tabId)?.state ?? 'idle'
}

/** 查询是否处于冻结态 */
export function isFrozen(tabId: string): boolean {
  return getFreezeState(tabId) === 'frozen'
}

/** 当前所有冻结中的 tabId（用于退出时批量恢复） */
export function getFrozenTabs(): string[] {
  const result: string[] = []
  for (const [tabId, s] of sessions) {
    if (s.state === 'frozen') result.push(tabId)
  }
  return result
}

/** 应用退出前批量恢复所有冻结的 webview（避免残留 debugger 阻止退出） */
export async function detachAll(): Promise<void> {
  const tabIds = Array.from(sessions.keys())
  await Promise.all(tabIds.map((id) => detachTab(id)))
  console.log(`[freeze] 已批量分离 ${tabIds.length} 个会话`)
}
