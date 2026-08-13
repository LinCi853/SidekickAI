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

import { type BrowserWindow, type WebContents } from 'electron'
import type {
  FreezeState,
  TextLayer,
  TextLayerItem,
} from '../shared/api/freeze.api.js'
import { getWebviewByTabId, listRegisteredWebviews } from './webview-registry.js'

export type { FreezeState, TextLayer, TextLayerItem }

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

interface DebuggerRuntime {
  childSessions: Set<string>
  messageHandler: (
    event: Electron.Event,
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ) => void
  detachHandler: () => void
}

const debuggerRuntimes = new Map<number, DebuggerRuntime>()
const pausingWebContents = new Set<number>()
const expectedDebuggerDetaches = new Set<number>()

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

function isWebContentsFrozen(webContentsId: number): boolean {
  for (const session of sessions.values()) {
    if (session.webContentsId === webContentsId && session.state === 'frozen') return true
  }
  return false
}

async function sendChildCommand(
  wc: WebContents,
  sessionId: string,
  command: string,
): Promise<void> {
  try {
    await wc.debugger.sendCommand(command, {}, sessionId)
  } catch (err) {
    console.warn(`[freeze] 子目标 ${sessionId} 执行 ${command} 失败:`, err)
  }
}

function cleanupDebuggerRuntime(wc: WebContents): void {
  const runtime = debuggerRuntimes.get(wc.id)
  if (!runtime) return
  wc.debugger.removeListener('message', runtime.messageHandler)
  wc.debugger.removeListener('detach', runtime.detachHandler)
  debuggerRuntimes.delete(wc.id)
  pausingWebContents.delete(wc.id)
}

function handleUnexpectedDebuggerDetach(webContentsId: number): void {
  for (const [tabId, session] of sessions) {
    if (session.webContentsId !== webContentsId) continue
    sessions.delete(tabId)
    broadcast(tabId, 'idle')
  }
}

function ensureDebuggerRuntime(wc: WebContents): DebuggerRuntime {
  const current = debuggerRuntimes.get(wc.id)
  if (current) return current

  const runtime = {} as DebuggerRuntime
  runtime.childSessions = new Set<string>()
  runtime.messageHandler = (_event, method, params) => {
    if (method === 'Target.detachedFromTarget') {
      const detachedId = typeof params.sessionId === 'string' ? params.sessionId : ''
      if (detachedId) runtime.childSessions.delete(detachedId)
      return
    }
    if (method !== 'Target.attachedToTarget') return
    const childId = typeof params.sessionId === 'string' ? params.sessionId : ''
    if (!childId) return
    runtime.childSessions.add(childId)
    void sendChildCommand(wc, childId, 'Debugger.enable').then(() => {
      return wc.debugger.sendCommand('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      }, childId).catch((err) => {
        console.warn(`[freeze] 子目标 ${childId} 递归 autoAttach 失败:`, err)
      })
    }).then(() => {
      if (pausingWebContents.has(wc.id) || isWebContentsFrozen(wc.id)) {
        return sendChildCommand(wc, childId, 'Debugger.pause')
      }
    })
  }
  runtime.detachHandler = () => {
    cleanupDebuggerRuntime(wc)
    if (!expectedDebuggerDetaches.has(wc.id)) handleUnexpectedDebuggerDetach(wc.id)
  }
  wc.debugger.on('message', runtime.messageHandler)
  wc.debugger.on('detach', runtime.detachHandler)
  debuggerRuntimes.set(wc.id, runtime)
  return runtime
}

async function pauseDebuggerTargets(wc: WebContents): Promise<void> {
  const runtime = ensureDebuggerRuntime(wc)
  pausingWebContents.add(wc.id)
  await Promise.all(Array.from(runtime.childSessions, async (sessionId) => {
    await wc.debugger.sendCommand('Debugger.enable', {}, sessionId)
    await wc.debugger.sendCommand('Debugger.pause', {}, sessionId)
  }))
  await wc.debugger.sendCommand('Debugger.pause')
}

async function resumeDebuggerTargets(wc: WebContents): Promise<void> {
  const runtime = debuggerRuntimes.get(wc.id)
  if (runtime) {
    await Promise.all(Array.from(runtime.childSessions, (sessionId) => (
      sendChildCommand(wc, sessionId, 'Debugger.resume')
    )))
  }
  await wc.debugger.sendCommand('Debugger.resume')
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
  if (!wc.debugger.isAttached()) await wc.debugger.attach('1.3')
  ensureDebuggerRuntime(wc)
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
const TEXT_LAYER_MAX_GRAPHEMES = 50000

/**
 * 字符边界提取脚本（主路径，冻结前 executeJavaScript 执行）：
 *   - Intl.Segmenter 按 grapheme cluster 切分文本
 *   - 每个 grapheme 用 Range.getClientRects() 获取 guest 视口真实边界
 *   - 按视觉行聚合为 run，并保存完整排版样式供裁剪式反色渲染
 */
const GLYPH_EXTRACT_SCRIPT = `(async function() {
  try {
    var MAX = ${TEXT_LAYER_MAX_ITEMS}
    var MAX_GRAPHEMES = ${TEXT_LAYER_MAX_GRAPHEMES}
    try {
      if (document.fonts) {
        await Promise.race([document.fonts.ready, new Promise(function(r) { setTimeout(r, 800) })])
      }
    } catch (_) {}
    var vv = window.visualViewport
    var scrollX = window.scrollX || document.documentElement.scrollLeft || 0
    var scrollY = window.scrollY || document.documentElement.scrollTop || 0
    var items = []
    var graphemeCount = 0
    var truncated = false
    var lineNo = 0
    var visualLines = []
    var previousBlock = null
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    var n
    var segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
    function getBlock(el) {
      var cur = el
      while (cur && cur !== document.body) {
        var display = getComputedStyle(cur).display
        if (/^(block|list-item|table|table-row|flex|grid|flow-root)$/.test(display)) return cur
        cur = cur.parentElement
      }
      return document.body
    }
    function followsBreak(node) {
      var cur = node
      while (cur && cur !== document.body) {
        var prev = cur.previousSibling
        while (prev && prev.nodeType === Node.TEXT_NODE && !(prev.nodeValue || '').trim()) prev = prev.previousSibling
        if (prev) return prev.nodeType === Node.ELEMENT_NODE && prev.tagName === 'BR'
        cur = cur.parentNode
      }
      return false
    }
    function getVisualLine(rect) {
      var found = visualLines.find(function(line) {
        return line.block === block && rect.bottom > line.top + 1 && rect.top < line.bottom - 1
      })
      if (!found) {
        found = { id: lineNo++, block: block, top: rect.top, bottom: rect.bottom }
        visualLines.push(found)
      } else {
        found.top = Math.min(found.top, rect.top)
        found.bottom = Math.max(found.bottom, rect.bottom)
      }
      return found.id
    }
    while ((n = walker.nextNode())) {
      if (items.length >= MAX) { truncated = true; break }
      var raw = n.nodeValue || ''
      if (!raw) continue
      var el = n.parentElement
      if (!el) continue
      var cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden') continue
      var block = getBlock(el)
      var pendingBreak = items.length > 0 && (block !== previousBlock || followsBreak(n))
      var transformed = false
      var viewportFixed = false
      var sticky = false
      var ancestor = el
      while (ancestor && ancestor !== document.body) {
        var ancestorStyle = getComputedStyle(ancestor)
        if (ancestorStyle.transform !== 'none') transformed = true
        if (ancestorStyle.position === 'fixed') viewportFixed = true
        if (ancestorStyle.position === 'sticky') sticky = true
        ancestor = ancestor.parentElement
      }
      var segments = segmenter
        ? Array.from(segmenter.segment(raw)).map(function(s) { return { text: s.segment, start: s.index, end: s.index + s.segment.length } })
        : (function() {
            var offset = 0
            return Array.from(raw).map(function(c) {
              var result = { text: c, start: offset, end: offset + c.length }
              offset += c.length
              return result
            })
          })()
      var nodeLines = []
      segments.forEach(function(seg) {
        if (items.length >= MAX || graphemeCount >= MAX_GRAPHEMES) { truncated = true; return }
        var range = document.createRange()
        range.setStart(n, seg.start)
        range.setEnd(n, seg.end)
        var rects = Array.from(range.getClientRects()).filter(function(r) { return r.width > 0 || r.height > 0 })
        if (!rects.length) {
          if (/\r|\n/.test(seg.text)) pendingBreak = true
          return
        }
        var r = rects[0]
        var line = nodeLines.find(function(l) { return Math.abs(l.y - r.top) <= 1 && Math.abs(l.h - r.height) <= 2 })
        if (!line) {
          line = { line: getVisualLine(r), x: r.left, y: r.top, right: r.right, h: r.height, text: '', graphemes: [], breakBefore: pendingBreak }
          nodeLines.push(line)
          items.push(line)
        }
        if (pendingBreak && line.text.length === 0) line.breakBefore = true
        pendingBreak = false
        line.x = Math.min(line.x, r.left)
        line.right = Math.max(line.right, r.right)
        line.h = Math.max(line.h, r.height)
        line.text += seg.text
        line.graphemes.push({ text: seg.text, start: seg.start, end: seg.end, x: r.left, y: r.top, w: r.width, h: r.height, line: line.line })
        graphemeCount++
      })
      nodeLines.forEach(function(line) {
        line.w = line.right - line.x
        line.transformed = transformed
        line.verticalWriting = cs.writingMode !== 'horizontal-tb'
        line.viewportFixed = viewportFixed
        line.sticky = sticky
        line.direction = cs.direction || 'ltr'
      })
      if (nodeLines.length) previousBlock = block
    }
    return JSON.stringify({
      items: items,
      scrollOffsetX: scrollX,
      scrollOffsetY: scrollY,
      contentWidth: document.documentElement.scrollWidth || document.body.scrollWidth || 0,
      contentHeight: document.documentElement.scrollHeight || document.body.scrollHeight || 0,
      viewportWidth: vv ? vv.width : window.innerWidth,
      viewportHeight: vv ? vv.height : window.innerHeight,
      visualScale: vv ? vv.scale || 1 : 1,
      devicePixelRatio: window.devicePixelRatio || 1,
      truncated: truncated
    })
  } catch (e) {
    return JSON.stringify({ error: String((e && e.message) || e) })
  }
})()`

/**
 * 提取页面文本层（冻结前调用）。
 * 主路径：executeJavaScript 按 grapheme 提取 Range 边界与完整排版样式。
 * 降级路径：DOMSnapshot textBoxes（无字体样式，渲染层仅背景高亮）。
 */
export async function extractTextLayer(wc: WebContents): Promise<TextLayer | null> {
  // 先 attach 但不 pause，保证主路径失败时 DOMSnapshot fallback 可用
  await attach(wc)
  // ——— 主路径：字符边界 + 样式提取———
  try {
    const ret = await wc.executeJavaScript(GLYPH_EXTRACT_SCRIPT)
    const parsed = JSON.parse(String(ret)) as {
      items?: Array<{
        text?: string
        x?: number
        y?: number
        w?: number
        h?: number
        line?: number
        breakBefore?: boolean
        transformed?: boolean
        verticalWriting?: boolean
        viewportFixed?: boolean
        sticky?: boolean
        direction?: string
        graphemes?: Array<{
          text?: string
          start?: number
          end?: number
          x?: number
          y?: number
          w?: number
          h?: number
          line?: number
        }>
      }>
      scrollOffsetX?: number
      scrollOffsetY?: number
      contentWidth?: number
      contentHeight?: number
      viewportWidth?: number
      viewportHeight?: number
      visualScale?: number
      devicePixelRatio?: number
      truncated?: boolean
      error?: string
    }
    if (parsed.error) {
      console.warn('[freeze] 行盒提取失败，降级到 DOMSnapshot:', parsed.error)
    } else {
      const items: TextLayerItem[] = (parsed.items || [])
        .map((i) => ({
          text: i.text || '',
          x: Number(i.x) || 0,
          y: Number(i.y) || 0,
          w: Number(i.w) || 0,
          h: Number(i.h) || 0,
          line: Number(i.line) || 0,
          breakBefore: Boolean(i.breakBefore),
          transformed: Boolean(i.transformed),
          verticalWriting: Boolean(i.verticalWriting),
          viewportFixed: Boolean(i.viewportFixed),
          sticky: Boolean(i.sticky),
          direction: i.direction,
          graphemes: (i.graphemes || []).map((g) => ({
            text: g.text || '',
            start: Number(g.start) || 0,
            end: Number(g.end) || 0,
            x: Number(g.x) || 0,
            y: Number(g.y) || 0,
            w: Number(g.w) || 0,
            h: Number(g.h) || 0,
            line: Number(g.line) || 0,
          })),
        }))
        .filter((i) => i.text.length > 0)
      if (items.length > 0) {
        console.log(`[freeze] 文本层提取完成（字符边界+样式）: items=${items.length}, truncated=${Boolean(parsed.truncated)}`)
        return {
          version: 2,
          coordinateSpace: 'guest-visual-viewport-css-px-v2',
          items,
          scrollOffsetX: Number(parsed.scrollOffsetX) || 0,
          scrollOffsetY: Number(parsed.scrollOffsetY) || 0,
          contentWidth: Number(parsed.contentWidth) || 0,
          contentHeight: Number(parsed.contentHeight) || 0,
          viewportWidth: Number(parsed.viewportWidth) || 0,
          viewportHeight: Number(parsed.viewportHeight) || 0,
          visualScale: Number(parsed.visualScale) || 1,
          devicePixelRatio: Number(parsed.devicePixelRatio) || 1,
          quality: 'glyph',
          truncated: Boolean(parsed.truncated),
        }
      }
      console.warn('[freeze] 行盒提取为空，降级到 DOMSnapshot')
    }
  } catch (err) {
    console.warn('[freeze] 行盒提取异常，降级到 DOMSnapshot:', err)
  }

  // ——— 降级路径：DOMSnapshot textBoxes（无字体样式，坐标精确）———
  try {
    const snap = await wc.debugger.sendCommand('DOMSnapshot.captureSnapshot', {
      computedStyles: [],
      includeDOMRects: true,
      includePaintOrder: false,
    })
    const strings: string[] = snap.strings || []
    const items: TextLayerItem[] = []
    const metrics = await wc.debugger.sendCommand('Page.getLayoutMetrics').catch(() => null)
    const visualViewport = metrics?.cssVisualViewport || metrics?.visualViewport
    const contentSize = metrics?.cssContentSize || metrics?.contentSize
    let scrollOffsetX = Number(visualViewport?.pageX) || 0
    let scrollOffsetY = Number(visualViewport?.pageY) || 0
    let contentWidth = Number(contentSize?.width) || 0
    let contentHeight = Number(contentSize?.height) || 0
    for (const doc of snap.documents) {
      scrollOffsetX = Math.max(scrollOffsetX, Number(doc.scrollOffsetX) || 0)
      scrollOffsetY = Math.max(scrollOffsetY, Number(doc.scrollOffsetY) || 0)
      contentWidth = Math.max(contentWidth, Number(doc.contentWidth) || 0)
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
          text,
          x: b[0] - scrollOffsetX,
          y: b[1] - scrollOffsetY,
          w: b[2],
          h: b[3],
          line: items.length,
        })
      }
    }
    if (items.length > 0) {
      console.log(`[freeze] 文本层提取完成（DOMSnapshot textBoxes 降级）: items=${items.length}`)
      return {
        version: 2,
        coordinateSpace: 'guest-visual-viewport-css-px-v2',
        items,
        scrollOffsetX,
        scrollOffsetY,
        contentWidth,
        contentHeight,
        viewportWidth: Number(visualViewport?.clientWidth) || 0,
        viewportHeight: Number(visualViewport?.clientHeight) || 0,
        visualScale: 1,
        devicePixelRatio: 1,
        quality: 'domsnapshot',
        truncated: items.length >= TEXT_LAYER_MAX_ITEMS,
      }
    }
    console.warn('[freeze] DOMSnapshot 文本层为空（页面无可选文本？）')
    return null
  } catch (err) {
    console.warn('[freeze] 提取文本层失败:', err)
    return null
  }
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
export async function freezeTab(tabId: string, textLayer?: TextLayer | null): Promise<boolean> {
  if (!acquireTransition(tabId)) return false
  const wc = getWebviewByTabId(tabId)
  if (!wc) {
    releaseTransition(tabId)
    console.warn(`[freeze] tab ${tabId} 的 webview 未找到（注册表: ${listRegisteredWebviews().length} 条）`)
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
        pausingWebContents.delete(wc.id)
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
      pausingWebContents.delete(wc.id)
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
        pausingWebContents.delete(wc.id)
        console.warn(`[freeze] tab ${tabId} pause 期间窗口失焦，已立即恢复`)
        return false
      }
      existing.state = 'frozen'
      existing.frozenAt = Date.now()
      if (textLayer) existing.textLayer = textLayer
      sessions.set(tabId, existing)
      pausingWebContents.delete(wc.id)
      console.log(`[freeze] tab ${tabId} 已冻结（复用已 attach 的 debugger）`)
      return true
    }
    // 已冻结 → 幂等返回
    console.log(`[freeze] tab ${tabId} 已处于冻结态，跳过`)
    return true
  } catch (err) {
    pausingWebContents.delete(wc.id)
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

/** guest 销毁时清除与该 webContents 精确匹配的会话。 */
export function clearDestroyedFreezeSession(tabId: string, webContentsId: number): boolean {
  debuggerRuntimes.delete(webContentsId)
  pausingWebContents.delete(webContentsId)
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
