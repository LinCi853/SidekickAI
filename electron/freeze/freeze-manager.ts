// electron/freeze/freeze-manager.ts — 页面冻结管理器（Debugger.pause 彻底定格 + 文本层）
//
// 防撤回保险的核心：对 webview 的 guest webContents 执行 Debugger.pause，
// 锁死 JS 主线程（定时器/rAF/事件/SSE 回调全部停止），页面画面彻底定格。
//
// 冻结策略演进（scripts/freeze-poc-*.cjs 逐轮验证）：
//   v1-v3 Debugger.pause 彻底定格（虚拟时间方案在有 SSE 页面不可靠已移除）
//   v4-v6 智能解冻交互（before-input-event / 宿主 DOM / uiohook 触发链）——
//       用户实测确认：冻结画面不应在交互时「活过来」（追帧/内容跳变），
//       改为应用组件实现选中复制，冻结永不解除。
//   v7 文本层方案（当前）—— 冻结前用 CDP DOMSnapshot.captureSnapshot 提取
//       页面文本层（文本 + 文档坐标 + scrollOffset，freeze-poc-textlayer.cjs
//       验证：bounds[i]=[x,y,w,h] 文档坐标、strings 在顶层返回）。冻结后由
//       渲染层覆盖「选择层」组件：拖拽高亮预览 → 矩形∩文本层拼文本 →
//       主进程写剪贴板。页面保持 Debugger.pause 绝对定格，永不 resume
//       （除非用户 Alt+P 主动恢复）。
//
// 关键约束（PoC 中确认）：
//   - Debugger.pause 后 executeJavaScript 会 hang（注入脚本无法在暂停的
//     isolate 上返回），故「先抓取 → 先提取文本层 → 再冻结锁现场」。
//   - DOMSnapshot 在 paused 下调用行为不稳定（可能隐式 resume），必须
//     在冻结前提取。

import { type BrowserWindow, type Input, type WebContents } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import { getWebviewByTabId, listRegisteredWebviews } from './webview-registry.js'

/** 冻结状态 */
export type FreezeState = 'idle' | 'attached' | 'frozen'

/** 文本层单项：文本 + 文档坐标（CSS 像素，相对文档左上角） */
export interface TextLayerItem {
  text: string
  x: number
  y: number
  w: number
  h: number
}

/** 冻结时提取的文本层（供渲染层选择层做选中/复制） */
export interface TextLayer {
  items: TextLayerItem[]
  /** 冻结瞬间页面垂直滚动偏移（视口坐标 = 文档坐标 - scrollOffsetY - 用户滚轮累计） */
  scrollOffsetY: number
  /** 页面内容总高度（判断滚动边界用） */
  contentHeight: number
  viewportHeight: number
}

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

// ==================== guest 侧 Alt+P 钩子（前台任意焦点可触发） ====================
// 焦点在 webview 时键盘路由到 guest，宿主（helpers.ts）的 before-input-event
// 收不到 Alt+P。webview 注册时挂一次 guest 钩子：
//   - 冻结态 → 恢复
//   - 未冻结 → 转发宿主渲染层走原有冻结流程（toggleFreeze）

const hotkeyHandlers = new Map<string, (event: Electron.Event, input: Input) => void>()

/** 给 guest webContents 挂 Alt+P 键盘钩子（webview 注册时调用，幂等） */
export function attachTabHotkey(tabId: string): void {
  if (hotkeyHandlers.has(tabId)) return
  const wc = getWebviewByTabId(tabId)
  if (!wc || wc.isDestroyed()) return
  const handler = (event: Electron.Event, input: Input) => {
    if (input.type !== 'keyDown') return
    if (!(input.alt && !input.control && !input.meta && !input.shift)) return
    if ((input.key || '').toLowerCase() !== 'p') return
    const s = sessions.get(tabId)
    event.preventDefault()
    if (s?.state === 'frozen') {
      // 冻结态：直接恢复（焦点在 guest 时宿主拦截不到）
      console.log(`[freeze] tab ${tabId} Alt+P → 恢复`)
      void resumeTab(tabId).then((ok) => {
        if (ok) broadcast(tabId, 'attached')
      })
    } else {
      // 未冻结：转发宿主渲染层走原有冻结流程
      const win = getOwnerWindow(wc)
      if (win && !win.isDestroyed()) {
        console.log(`[freeze] tab ${tabId} Alt+P → 请求冻结（guest 侧兜底）`)
        win.webContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'toggleFreeze' })
      }
    }
  }
  wc.on('before-input-event', handler)
  hotkeyHandlers.set(tabId, handler)
}

/** 移除 guest 侧 Alt+P 钩子（detach 时调用） */
function detachTabHotkey(tabId: string): void {
  const h = hotkeyHandlers.get(tabId)
  if (h) {
    const wc = getWebviewByTabId(tabId)
    if (wc && !wc.isDestroyed()) wc.removeListener('before-input-event', h)
    hotkeyHandlers.delete(tabId)
  }
}

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

/** 文本层上限（防真实 AI 页面超大 DOM 导致 IPC 传输失败） */
const TEXT_LAYER_MAX_ITEMS = 5000
const TEXT_LAYER_MAX_LEN = 500

/**
 * 降级提取脚本（DOMSnapshot 不可用/为空时）：遍历文本节点，取父元素
 * getBoundingClientRect（视口坐标 + 滚动偏移 = 文档坐标）。
 * 冻结前调用（executeJavaScript 需未冻结态）。
 */
const FALLBACK_EXTRACT_SCRIPT = `(function() {
  try {
    var scrolled = window.scrollY || document.documentElement.scrollTop || 0
    var items = []
    var MAX = ${TEXT_LAYER_MAX_ITEMS}
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    var n
    while ((n = walker.nextNode()) && items.length < MAX) {
      var text = (n.nodeValue || '').trim()
      if (!text) continue
      var el = n.parentElement
      if (!el) continue
      var r = el.getBoundingClientRect()
      if (!r || (r.width === 0 && r.height === 0)) continue
      items.push({
        text: text.length > ${TEXT_LAYER_MAX_LEN} ? text.slice(0, ${TEXT_LAYER_MAX_LEN}) : text,
        x: r.left,
        y: r.top + scrolled,
        w: r.width,
        h: r.height
      })
    }
    return JSON.stringify({
      items: items,
      scrollOffsetY: scrolled,
      contentHeight: document.body.scrollHeight || 0
    })
  } catch (e) {
    return JSON.stringify({ error: String((e && e.message) || e) })
  }
})()`

/**
 * 提取页面文本层（冻结前调用；DOMSnapshot 读取布局树，不执行 JS）。
 * 主路径使用 textBoxes（行盒级：每行文本的精确坐标 + 文本起止），粒度接近
 * 原生 selection 高亮（freeze-poc-textbox.cjs 验证：跨行文本拆行盒、
 * 坐标精确、文档坐标系）。失败/为空时降级到 executeJavaScript 提取。
 */
export async function extractTextLayer(wc: WebContents): Promise<TextLayer | null> {
  // ——— 主路径：DOMSnapshot textBoxes（行盒级，精确坐标）———
  try {
    const snap = await wc.debugger.sendCommand('DOMSnapshot.captureSnapshot', {
      computedStyles: [],
      includeDOMRects: true,
      includePaintOrder: false,
    })
    const strings: string[] = snap.strings || []
    const items: TextLayerItem[] = []
    let scrollOffsetY = 0
    let contentHeight = 0
    for (const doc of snap.documents) {
      scrollOffsetY = Math.max(scrollOffsetY, Number(doc.scrollOffsetY) || 0)
      contentHeight = Math.max(contentHeight, Number(doc.contentHeight) || 0)
      const layouts = doc.layout
      const textBoxes = doc.textBoxes
      if (!layouts || !textBoxes) continue
      const textIndexes: number[] = layouts.text || []
      const boxLayoutIdx: number[] = textBoxes.layoutIndex || []
      const boxStart: number[] = textBoxes.start || []
      const boxLen: number[] = textBoxes.length || []
      const boxBounds: number[][] = textBoxes.bounds || []
      for (let i = 0; i < boxLayoutIdx.length && items.length < TEXT_LAYER_MAX_ITEMS; i++) {
        const li = boxLayoutIdx[i]
        if (li === undefined || li < 0 || li >= textIndexes.length) continue
        const sIdx = textIndexes[li]
        if (sIdx === undefined || sIdx === -1) continue
        const full = strings[sIdx] || ''
        const start = boxStart[i] || 0
        const len = boxLen[i] || 0
        const text = full.slice(start, start + len)
        if (!text || !text.trim()) continue
        const b = boxBounds[i]
        if (!b || b.length < 4) continue
        items.push({
          text: text.length > TEXT_LAYER_MAX_LEN ? text.slice(0, TEXT_LAYER_MAX_LEN) : text,
          x: b[0],
          y: b[1],
          w: b[2],
          h: b[3],
        })
      }
    }
    if (items.length > 0) {
      console.log(`[freeze] 文本层提取完成（textBoxes 行盒）: items=${items.length}`)
      return { items, scrollOffsetY, contentHeight, viewportHeight: 0 }
    }
    console.warn('[freeze] DOMSnapshot 文本层为空，降级到 JS 提取')
  } catch (err) {
    console.warn('[freeze] DOMSnapshot 提取失败，降级到 JS 提取:', err)
  }

  // ——— 降级路径：executeJavaScript 文本节点提取（未冻结态可执行）———
  try {
    const ret = await wc.executeJavaScript(FALLBACK_EXTRACT_SCRIPT)
    const parsed = JSON.parse(String(ret)) as {
      items?: Array<{ text?: string; x?: number; y?: number; w?: number; h?: number }>
      scrollOffsetY?: number
      contentHeight?: number
      error?: string
    }
    if (parsed.error) {
      console.warn('[freeze] 降级提取失败:', parsed.error)
      return null
    }
    const items: TextLayerItem[] = (parsed.items || [])
      .map((i) => ({
        text: (i.text || '').slice(0, TEXT_LAYER_MAX_LEN),
        x: Number(i.x) || 0,
        y: Number(i.y) || 0,
        w: Number(i.w) || 0,
        h: Number(i.h) || 0,
      }))
      .filter((i) => i.text.trim())
    if (items.length === 0) {
      console.warn('[freeze] 降级提取文本层为空（页面无可选文本？）')
      return null
    }
    return {
      items,
      scrollOffsetY: Number(parsed.scrollOffsetY) || 0,
      contentHeight: Number(parsed.contentHeight) || 0,
      viewportHeight: 0,
    }
  } catch (err) {
    console.warn('[freeze] 提取文本层失败:', err)
    return null
  }
}

/** 查询指定 tab 的冻结会话（导出给 freeze-ipc 用） */
export function getFreezeSession(tabId: string): { textLayer?: TextLayer; state: FreezeState } | null {
  const s = sessions.get(tabId)
  return s ? { textLayer: s.textLayer, state: s.state } : null
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
export async function freezeTab(tabId: string, textLayer?: TextLayer | null): Promise<boolean> {
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
      sessions.set(tabId, {
        webContentsId: wc.id,
        state: 'frozen',
        attachedAt: existing?.attachedAt ?? Date.now(),
        frozenAt: Date.now(),
        textLayer: textLayer ?? undefined,
      })
      // 窗口失焦（应用切后台）自动恢复
      ensureBlurAutoResume(wc)
      console.log(`[freeze] tab ${tabId} 已冻结`)
      return true
    }
    if (existing.state === 'attached') {
      // 已 attach 未冻结 → 直接 pause
      await wc.debugger.sendCommand('Debugger.pause')
      existing.state = 'frozen'
      existing.frozenAt = Date.now()
      if (textLayer) existing.textLayer = textLayer
      sessions.set(tabId, existing)
      ensureBlurAutoResume(wc)
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
  // 移除 guest 侧 Alt+P 钩子（webview 销毁/分离时清理）
  detachTabHotkey(tabId)
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
