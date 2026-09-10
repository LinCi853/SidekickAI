// electron/freeze/freeze-manager.ts — 页面冻结管理器（Debugger.pause 彻底定格 + 文本层）
//
// 防撤回保险的核心：对 webview 的 guest webContents 执行 Debugger.pause，
// 锁死 JS 主线程（定时器/rAF/事件/SSE 回调全部停止），页面画面彻底定格。
//
// 冻结策略演进（曾用本地 PoC 脚本逐轮验证，PoC 未入库）：
//   v1-v3 Debugger.pause 彻底定格（虚拟时间方案在有 SSE 页面不可靠已移除）
//   v4-v6 智能解冻交互（before-input-event / 宿主 DOM / uiohook 触发链）——
//       用户实测确认：冻结画面不应在交互时「活过来」（追帧/内容跳变），
//       改为应用组件实现选中复制，冻结永不解除。
//   v7 文本层方案（当前）—— 冻结前用 CDP DOMSnapshot.captureSnapshot 提取
//       页面文本层（文本 + 文档坐标 + scrollOffset，已由 PoC 验证：
//       bounds[i]=[x,y,w,h] 文档坐标、strings 在顶层返回）。冻结后由
//       渲染层覆盖「选择层」组件：拖拽高亮预览 → 矩形∩文本层拼文本 →
//       主进程写剪贴板。页面保持 Debugger.pause 绝对定格，永不 resume
//       （除非用户 Alt+P 主动恢复）。
//
// 关键约束（PoC 中确认）：
//   - Debugger.pause 后 executeJavaScript 会 hang（注入脚本无法在暂停的
//     isolate 上返回），故「先抓取 → 先提取文本层 → 再冻结锁现场」。
//   - DOMSnapshot 在 paused 下调用行为不稳定（可能隐式 resume），必须
//     在冻结前提取。
//
// 本文件作为公共 facade：保留全部导出函数/类型，CDP 机制与文本层逻辑
// 分别拆分到 debugger-session.ts 与 text-layer.ts。

import { type BrowserWindow, type WebContents } from 'electron'
import type {
  FreezeState,
  TextLayer,
  TextLayerItem,
} from '../shared/api/freeze.api.js'
import { getWebviewByTabId, listRegisteredWebviews } from './webview-registry.js'
import {
  attach,
  cleanupDebuggerRuntime,
  debuggerRuntimes,
  expectedDebuggerDetaches,
  pauseDebuggerTargets,
  resumeDebuggerTargets,
  setUnexpectedDetachHandler,
} from './debugger-session.js'

export type { FreezeState, TextLayer, TextLayerItem }
export { extractTextLayer, GLYPH_EXTRACT_SCRIPT, isTextLayerCurrent } from './text-layer.js'

/** 单个 webContents 的冻结会话 */
interface FreezeSession {
  webContentsId: number
  state: FreezeState
  /** attach 时间戳 */
  attachedAt: number
  /** pause 时间戳（未冻结为 null） */
  frozenAt: number | null
  /** 冻结前提取的文本层（渲染层选中复制用） */
  textLayer?: TextLayer
}

/** tabId → 冻结会话 */
const sessions = new Map<string, FreezeSession>()
/** tab 级状态转换锁：防止 guest/host/renderer 多入口并发冻结或恢复 */
const transitionLocks = new Set<string>()

function acquireTransition(tabId: string): boolean {
  if (transitionLocks.has(tabId)) {
    console.warn(`[freeze] tab ${tabId} 状态转换进行中，忽略重复请求`)
    return false
  }
  transitionLocks.add(tabId)
  return true
}

function releaseTransition(tabId: string): void {
  transitionLocks.delete(tabId)
}

/**
 * 获取 guest webContents 所属窗口。
 * webContents.getOwnerBrowserWindow 运行时存在（POC 验证）但 Electron 30 类型
 * 定义缺失，用类型断言访问。
 */
function getOwnerWindow(wc: WebContents): BrowserWindow | null {
  const fn = (wc as unknown as { getOwnerBrowserWindow?: () => BrowserWindow | null }).getOwnerBrowserWindow
  return typeof fn === 'function' ? (fn.call(wc) ?? null) : null
}

/** 状态变化广播回调（freeze-ipc 注入，用于通知渲染层） */
type StateBroadcaster = (tabId: string, state: FreezeState) => void
let stateBroadcaster: StateBroadcaster | null = null

/** 注册状态广播回调（freeze-ipc 调用） */
export function setFreezeStateBroadcaster(cb: StateBroadcaster): void {
  stateBroadcaster = cb
}

function broadcast(tabId: string, state: FreezeState): void {
  stateBroadcaster?.(tabId, state)
}

// 意外 debugger detach 时清理该 webContents 对应的冻结会话并广播 idle。
setUnexpectedDetachHandler((webContentsId) => {
  for (const [tabId, session] of sessions) {
    if (session.webContentsId !== webContentsId) continue
    sessions.delete(tabId)
    broadcast(tabId, 'idle')
  }
})

// ==================== 窗口失焦自动恢复 ====================
// 「应用切换到后台自动取消暂停」：冻结 tab 所属窗口 blur（切后台/最小化/Alt+Tab）
// 时自动解除该窗口全部冻结。

const blurWatched = new Set<number>()

function ensureBlurAutoResume(wc: WebContents): void {
  const win = getOwnerWindow(wc)
  if (!win || win.isDestroyed()) return
  if (blurWatched.has(win.id)) return
  blurWatched.add(win.id)
  win.on('blur', () => {
    for (const [tabId, s] of sessions) {
      if (s.state !== 'frozen') continue
      const w = getWebviewByTabId(tabId)
      if (w && !w.isDestroyed() && getOwnerWindow(w)?.id === win.id) {
        console.log(`[freeze] 窗口失焦（应用切后台），自动恢复 tab ${tabId}`)
        void resumeTab(tabId).then((ok) => {
          if (ok) broadcast(tabId, 'attached')
        })
      }
    }
  })
}

/** 查询指定 tab 的冻结会话（导出给 freeze-ipc 用） */
export function getFreezeSession(tabId: string): { textLayer?: TextLayer; state: FreezeState } | null {
  const s = sessions.get(tabId)
  if (!s || getFreezeState(tabId) === 'idle') return null
  return { textLayer: s.textLayer, state: s.state }
}

/**
 * 冻结指定 tabId 的 webview。
 *
 * 注意：调用方应在调用此方法**之前**完成对话抓取与文本层提取
 * （executeJavaScript / DOMSnapshot 需要未冻结态），因为冻结后不可读。
 *
 * @param textLayer 冻结前提取的文本层（供渲染层选中复制），可为空
 * @returns 是否成功冻结
 */
export async function freezeTab(
  tabId: string,
  textLayer?: TextLayer | null,
  expectedWebContentsId?: number,
): Promise<boolean> {
  if (!acquireTransition(tabId)) return false
  const wc = getWebviewByTabId(tabId)
  if (!wc) {
    releaseTransition(tabId)
    console.warn(`[freeze] tab ${tabId} 的 webview 未找到（注册表: ${listRegisteredWebviews().length} 条）`)
    return false
  }
  if (expectedWebContentsId !== undefined && wc.id !== expectedWebContentsId) {
    releaseTransition(tabId)
    console.warn(`[freeze] tab ${tabId} 的 webContents 已更换，丢弃旧页面提取结果`)
    return false
  }

  let existing = sessions.get(tabId)
  if (existing && existing.webContentsId !== wc.id) {
    console.warn(`[freeze] tab ${tabId} 已更换 webContents，丢弃旧冻结会话`)
    sessions.delete(tabId)
    existing = undefined
  }
  const wasAttached = wc.debugger.isAttached()
  try {
    if (!existing || existing.state === 'idle') {
      await attach(wc)
      ensureBlurAutoResume(wc)
      const owner = getOwnerWindow(wc)
      if (owner && !owner.isDestroyed() && !owner.isFocused()) {
        console.warn(`[freeze] tab ${tabId} 所属窗口已失焦，取消冻结`)
        if (!wasAttached && wc.debugger.isAttached()) await wc.debugger.detach()
        return false
      }
      // 彻底定格：Debugger.pause 锁死 JS（动画/定时器/SSE 回调全停，画面定格）
      await pauseDebuggerTargets(wc)
      if (owner && !owner.isDestroyed() && !owner.isFocused()) {
        await resumeDebuggerTargets(wc)
        console.warn(`[freeze] tab ${tabId} pause 期间窗口失焦，已立即恢复`)
        return false
      }
      sessions.set(tabId, {
        webContentsId: wc.id,
        state: 'frozen',
        attachedAt: existing?.attachedAt ?? Date.now(),
        frozenAt: Date.now(),
        textLayer: textLayer ?? undefined,
      })
      console.log(`[freeze] tab ${tabId} 已冻结`)
      return true
    }
    if (existing.state === 'attached') {
      ensureBlurAutoResume(wc)
      const owner = getOwnerWindow(wc)
      if (owner && !owner.isDestroyed() && !owner.isFocused()) {
        console.warn(`[freeze] tab ${tabId} 所属窗口已失焦，取消冻结`)
        return false
      }
      // 已 attach 未冻结 → 直接 pause
      await pauseDebuggerTargets(wc)
      if (owner && !owner.isDestroyed() && !owner.isFocused()) {
        await resumeDebuggerTargets(wc)
        console.warn(`[freeze] tab ${tabId} pause 期间窗口失焦，已立即恢复`)
        return false
      }
      existing.state = 'frozen'
      existing.frozenAt = Date.now()
      if (textLayer) existing.textLayer = textLayer
      sessions.set(tabId, existing)
      console.log(`[freeze] tab ${tabId} 已冻结（复用已 attach 的 debugger）`)
      return true
    }
    // 已冻结 → 幂等返回
    console.log(`[freeze] tab ${tabId} 已处于冻结态，跳过`)
    return true
  } catch (err) {
    console.error(`[freeze] 冻结 tab ${tabId} 失败:`, err)
    if (!wasAttached && wc.debugger.isAttached()) {
      try {
        await wc.debugger.detach()
      } catch {
        /* ignore cleanup failure */
      }
    }
    return false
  } finally {
    releaseTransition(tabId)
  }
}

/**
 * 恢复指定 tabId 的 webview（解除冻结，页面无缝继续）。
 * @returns 是否成功恢复
 */
export async function resumeTab(tabId: string): Promise<boolean> {
  if (!acquireTransition(tabId)) return false
  try {
    const session = sessions.get(tabId)
    if (!session || session.state !== 'frozen') {
      console.log(`[freeze] tab ${tabId} 未冻结，无需恢复`)
      return false
    }
    const wc = getWebviewByTabId(tabId)
    if (!wc || wc.id !== session.webContentsId) {
      console.warn(`[freeze] tab ${tabId} 的 webview 已销毁或更换，清理会话`)
      sessions.delete(tabId)
      return false
    }
    await resumeDebuggerTargets(wc)
    session.state = 'attached'
    session.frozenAt = null
    sessions.set(tabId, session)
    console.log(`[freeze] tab ${tabId} 已恢复`)
    return true
  } catch (err) {
    console.error(`[freeze] 恢复 tab ${tabId} 失败:`, err)
    return false
  } finally {
    releaseTransition(tabId)
  }
}

/**
 * 彻底分离调试器（恢复 + detach）。
 * 用于退出冻结模式、切换标签、关闭页面时清理。
 */
export async function detachTab(tabId: string): Promise<boolean> {
  if (!acquireTransition(tabId)) return false
  try {
    const session = sessions.get(tabId)
    const wc = getWebviewByTabId(tabId)
    let cleanupSucceeded = true
    if (wc && !wc.isDestroyed()) {
      if (session?.state === 'frozen' && session.webContentsId === wc.id) {
        try {
          await resumeDebuggerTargets(wc)
          session.state = 'attached'
          session.frozenAt = null
          sessions.set(tabId, session)
        } catch (err) {
          cleanupSucceeded = false
          console.warn(`[freeze] resume tab ${tabId} 后再 detach 失败:`, err)
        }
      }
      try {
        if (wc.debugger.isAttached()) {
          expectedDebuggerDetaches.add(wc.id)
          await wc.debugger.detach()
        }
      } catch (err) {
        cleanupSucceeded = false
        console.warn(`[freeze] detach tab ${tabId} 失败:`, err)
      }
    }
    if (!cleanupSucceeded && wc?.debugger.isAttached()) return false
    if (wc) expectedDebuggerDetaches.delete(wc.id)
    if (wc) cleanupDebuggerRuntime(wc)
    sessions.delete(tabId)
    console.log(`[freeze] tab ${tabId} 已分离调试器`)
    return true
  } finally {
    const wc = getWebviewByTabId(tabId)
    if (wc) expectedDebuggerDetaches.delete(wc.id)
    releaseTransition(tabId)
  }
}

/** 清理已被注册表替换、但仍可能存活的精确 guest。 */
export async function detachWebContents(
  tabId: string,
  webContentsId: number,
  wc: WebContents | null,
): Promise<boolean> {
  if (!acquireTransition(tabId)) return false
  try {
    const session = sessions.get(tabId)
    let cleanupSucceeded = true
    if (wc && !wc.isDestroyed()) {
      if (session?.webContentsId === webContentsId && session.state === 'frozen') {
        try {
          await resumeDebuggerTargets(wc)
          session.state = 'attached'
          session.frozenAt = null
          sessions.set(tabId, session)
          broadcast(tabId, 'attached')
        } catch (err) {
          cleanupSucceeded = false
          console.warn(`[freeze] 替换 guest ${webContentsId} 前恢复失败:`, err)
        }
      }
      try {
        if (wc.debugger.isAttached()) {
          expectedDebuggerDetaches.add(webContentsId)
          await wc.debugger.detach()
        }
      } catch (err) {
        cleanupSucceeded = false
        console.warn(`[freeze] 替换 guest ${webContentsId} 前 detach 失败:`, err)
      } finally {
        expectedDebuggerDetaches.delete(webContentsId)
      }
      if (!cleanupSucceeded && wc.debugger.isAttached()) return false
      cleanupDebuggerRuntime(wc)
    }
    return true
  } finally {
    releaseTransition(tabId)
  }
}

/** guest 销毁时清除与该 webContents 精确匹配的会话。 */
export function clearDestroyedFreezeSession(tabId: string, webContentsId: number): boolean {
  debuggerRuntimes.delete(webContentsId)
  expectedDebuggerDetaches.delete(webContentsId)
  const session = sessions.get(tabId)
  if (session?.webContentsId !== webContentsId) return false
  sessions.delete(tabId)
  return true
}

/** 查询指定 tab 的冻结状态 */
export function getFreezeState(tabId: string): FreezeState {
  const session = sessions.get(tabId)
  if (!session) return 'idle'
  const wc = getWebviewByTabId(tabId)
  if (!wc || wc.id !== session.webContentsId) {
    sessions.delete(tabId)
    return 'idle'
  }
  if (!wc.debugger.isAttached()) {
    sessions.delete(tabId)
    return 'idle'
  }
  return session.state
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
