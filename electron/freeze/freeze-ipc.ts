// electron/freeze/freeze-ipc.ts — 页面冻结 IPC 注册
//
// 防撤回保险：渲染层请求冻结某 tab 时，主进程先抓取该 webview 的全量对话内容入库
// （此时未冻结，executeJavaScript 可正常返回），再 Debugger.pause 冻结页面锁现场。
//
// 关键约束（PoC 验证）：冻结后 executeJavaScript 会 hang，故必须「先抓取再冻结」。

import { ipcMain, webContents, BrowserWindow, clipboard, app, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import {
  registerWebview,
  getWebviewByTabId,
  setWebviewDestroyedHandler,
} from './webview-registry.js'
import {
  freezeTab,
  resumeTab,
  detachTab,
  getFreezeState,
  isFrozen,
  extractTextLayer,
  getFreezeSession,
  clearDestroyedFreezeSession,
  setFreezeStateBroadcaster,
} from './freeze-manager.js'
import type {
  FreezeActionResult,
  FreezeScrollResult,
  FreezeState,
  TextLayer,
} from '../shared/api/freeze.api.js'

/** 冻结时抓取的对话快照（用于入库 + 返回给渲染层显示） */
export interface FreezeSnapshot {
  /** 抓取到的对话 pairs */
  pairs: Array<{ user: string; assistant: string }>
  /** 页面标题 */
  title: string
  /** 页面 URL */
  url: string
  /** 抓取时间戳 */
  scrapedAt: number
}

/** 抓取脚本（与 src/pages/MainView/scripts.ts 的 SCRAPE_CHAT_SCRIPT 一致，主进程侧副本） */
const SCRAPE_SCRIPT = `(function() {
  try {
    var title = document.title || '';
    var url = location.href;
    var PLATFORM_SELECTORS = {
      'chatgpt.com': { user: '[data-message-author-role="user"]', assistant: '[data-message-author-role="assistant"]' },
      'claude.ai': { user: '[data-testid="user-message"]', assistant: '[data-testid="assistant-message"]' },
      'gemini.google.com': { user: '.query-text', assistant: '.model-response-text' },
      'doubao.com': { user: '[class*="user-message"]', assistant: '[class*="assistant-message"]' },
      'chatglm.cn': { user: '[class*="user-bubble"]', assistant: '[class*="assistant-bubble"]' },
      'deepseek.com': { user: '[class*="user-message"]', assistant: '[class*="assistant-message"]' },
      'kimi.moonshot.cn': { user: '[class*="user-message"]', assistant: '[class*="assistant-message"]' },
      'yiyan.baidu.com': { user: '[class*="user-msg"]', assistant: '[class*="assistant-msg"]' },
      'chat.mimo.com': { user: '[class*="user-message"]', assistant: '[class*="assistant-message"]' }
    };
    var FALLBACK = { user: '[class*="user-message"],[class*="user-msg"],[class*="user-bubble"]', assistant: '[class*="assistant-message"],[class*="assistant-msg"],[class*="assistant-bubble"]' };
    var sel = PLATFORM_SELECTORS[location.hostname] || FALLBACK;
    var userEls = Array.prototype.slice.call(document.querySelectorAll(sel.user));
    var asstEls = Array.prototype.slice.call(document.querySelectorAll(sel.assistant));
    var pairs = [];
    var max = Math.max(userEls.length, asstEls.length);
    for (var i = 0; i < max; i++) {
      pairs.push({
        user: userEls[i] ? (userEls[i].innerText || '').trim() : '',
        assistant: asstEls[i] ? (asstEls[i].innerText || '').trim() : ''
      });
    }
    return JSON.stringify({ pairs: pairs, title: title, url: url });
  } catch(e) {
    return JSON.stringify({ error: String((e && e.message) || e) });
  }
})()`

/** 抓取 webview 当前对话快照（未冻结态调用） */
async function scrapeSnapshot(wc: Electron.WebContents): Promise<FreezeSnapshot | null> {
  try {
    const ret = await wc.executeJavaScript(SCRAPE_SCRIPT)
    const parsed = JSON.parse(String(ret)) as {
      pairs?: Array<{ user?: string; assistant?: string }>
      title?: string
      url?: string
      error?: string
    }
    if (parsed.error) {
      console.warn('[freeze-ipc] 抓取对话失败:', parsed.error)
      return null
    }
    const pairs = (parsed.pairs || [])
      .map((p) => ({
        user: (p.user || '').slice(0, 50000),
        assistant: (p.assistant || '').slice(0, 50000),
      }))
      .filter((p) => p.user || p.assistant)
    return {
      pairs,
      title: parsed.title || '',
      url: parsed.url || '',
      scrapedAt: Date.now(),
    }
  } catch (err) {
    console.warn('[freeze-ipc] executeJavaScript 失败:', err)
    return null
  }
}

const stateRevisions = new Map<string, number>()

function getStateRevision(tabId: string): number {
  return stateRevisions.get(tabId) ?? 0
}

/** 广播冻结状态变化给所有窗口 */
function broadcastFreezeState(tabId: string, state: FreezeState): number {
  const revision = getStateRevision(tabId) + 1
  stateRevisions.set(tabId, revision)
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      try {
        w.webContents.send(IPC_CHANNELS.FREEZE_STATE_CHANGED, { tabId, state, revision })
      } catch {
        /* ignore */
      }
    }
  }
  return revision
}

/** IPC 入口级操作锁，覆盖抓取、字符提取、pause/resume 的完整链路。 */
const tabOperationTails = new Map<string, Promise<void>>()
const tabScrollOperations = new Map<string, Promise<FreezeScrollResult | null>>()

function runSerializedTabOperation<T>(
  tabId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = tabOperationTails.get(tabId) ?? Promise.resolve()
  const result = previous.catch(() => undefined).then(operation)
  const tail = result.then(() => undefined, () => undefined).finally(() => {
    if (tabOperationTails.get(tabId) === tail) tabOperationTails.delete(tabId)
  })
  tabOperationTails.set(tabId, tail)
  return result
}

function runTabOperation(
  tabId: string,
  operation: () => Promise<FreezeActionResult>,
): Promise<FreezeActionResult> {
  return runSerializedTabOperation(tabId, operation)
}

function runScrollOperation(
  tabId: string,
  operation: () => Promise<FreezeScrollResult | null>,
): Promise<FreezeScrollResult | null> {
  const previous = tabScrollOperations.get(tabId) ?? Promise.resolve(null)
  const pending = previous.catch(() => null).then(operation).finally(() => {
    if (tabScrollOperations.get(tabId) === pending) tabScrollOperations.delete(tabId)
  })
  tabScrollOperations.set(tabId, pending)
  return pending
}

async function persistSnapshot(
  profileId: string,
  snapshot: FreezeSnapshot,
): Promise<void> {
  try {
    const { getChatStore } = await import('../store/chat-store.js')
    const store = getChatStore()
    const conv = store.createConversation(
      profileId,
      'freeze-snapshot',
      `[冻结快照] ${snapshot.title || ''}`,
      snapshot.url,
    )
    for (const pair of snapshot.pairs) {
      if (pair.user && pair.user.trim().length >= 1) {
        store.saveMessageWithMerge({
          conversationId: conv.id,
          role: 'user',
          content: pair.user,
          autoGrabbed: true,
        })
      }
      if (pair.assistant && pair.assistant.trim().length >= 1) {
        store.saveMessageWithMerge({
          conversationId: conv.id,
          role: 'assistant',
          content: pair.assistant,
          autoGrabbed: true,
        })
      }
    }
    console.log(`[freeze-ipc] 冻结快照已入库: convId=${conv.id}, pairs=${snapshot.pairs.length}`)
  } catch (err) {
    console.error('[freeze-ipc] 冻结快照入库失败（现场仍保持冻结）:', err)
  }
}

async function performFreeze(payload: {
  tabId: string
  profileId: string
}): Promise<FreezeActionResult> {
  const wc = getWebviewByTabId(payload.tabId)
  if (!wc) {
    console.warn('[freeze-ipc] 冻结失败：tab webview 未找到', payload.tabId)
    return { frozen: false, state: 'idle', revision: getStateRevision(payload.tabId), snapshot: null, textLayer: null }
  }

  if (isFrozen(payload.tabId)) {
    const session = getFreezeSession(payload.tabId)
    return {
      frozen: true,
      state: 'frozen',
      revision: getStateRevision(payload.tabId),
      snapshot: null,
      textLayer: session?.textLayer ?? null,
    }
  }

  try {
    console.log('[freeze-ipc] 开始冻结 tab', payload.tabId, 'webContentsId=', wc.id, 'url=', wc.getURL?.())
    const snapshot = await scrapeSnapshot(wc)
    console.log('[freeze-ipc] 抓取快照完成, pairs=', snapshot?.pairs.length ?? 0)
    const textLayer = await extractTextLayer(wc)
    console.log('[freeze-ipc] 提取文本层完成, items=', textLayer?.items.length ?? 0)

    const ok = await freezeTab(payload.tabId, textLayer)
    const state = getFreezeState(payload.tabId)
    console.log('[freeze-ipc] freezeTab 返回', ok, '当前状态', state)
    let revision = getStateRevision(payload.tabId)
    if (ok && state === 'frozen') {
      revision = broadcastFreezeState(payload.tabId, 'frozen')
      if (snapshot && snapshot.pairs.length > 0) void persistSnapshot(payload.profileId, snapshot)
    } else if (wc.debugger.isAttached() && state === 'idle') {
      await detachTab(payload.tabId)
    }
    return {
      frozen: state === 'frozen',
      state,
      revision,
      snapshot: ok ? snapshot : null,
      textLayer: ok ? textLayer : null,
    }
  } catch (err) {
    console.error('[freeze-ipc] 冻结流程失败:', err)
    if (wc.debugger.isAttached() && getFreezeState(payload.tabId) === 'idle') {
      await detachTab(payload.tabId)
    }
    const state = getFreezeState(payload.tabId)
    return { frozen: state === 'frozen', state, revision: getStateRevision(payload.tabId), snapshot: null, textLayer: null }
  }
}

async function performResume(tabId: string): Promise<FreezeActionResult> {
  const ok = await resumeTab(tabId)
  const state = getFreezeState(tabId)
  const revision = ok ? broadcastFreezeState(tabId, state) : getStateRevision(tabId)
  return { frozen: state === 'frozen', state, revision, snapshot: null, textLayer: null }
}

async function performToggle(payload: {
  tabId: string
  profileId: string
}): Promise<FreezeActionResult> {
  return getFreezeState(payload.tabId) === 'frozen'
    ? performResume(payload.tabId)
    : performFreeze(payload)
}

/**
 * 宿主 webContents 的 Alt+P 拦截（冻结/恢复）。
 * 冻结后用户点击选择层（tabIndex 聚焦）→ 键盘焦点转移到宿主，Alt+P 路由
 * 宿主；而原 Alt+P 拦截（helpers.ts）只挂在 guest → 宿主焦点时快捷键失效。
 * 此处对每个窗口宿主 webContents 挂一份，与 helpers.ts 的唯一 guest 钩子
 * 互补，确保前台任意焦点 Alt+P 都能触发。
 */
const hostAltPHotkeySet = new Set<number>()

function attachHostAltPHotkey(win: BrowserWindow): void {
  if (win.isDestroyed() || hostAltPHotkeySet.has(win.webContents.id)) return
  hostAltPHotkeySet.add(win.webContents.id)
  win.webContents.once('destroyed', () => hostAltPHotkeySet.delete(win.webContents.id))
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    if (input.isAutoRepeat) return
    const mods = input.modifiers || []
    const hasAlt = mods.includes('alt')
    const hasCtrl = mods.includes('control') || mods.includes('ctrl')
    const hasShift = mods.includes('shift')
    const hasMeta = mods.includes('meta') || mods.includes('command')
    if (hasAlt && !hasCtrl && !hasShift && !hasMeta && (input.key || '').toLowerCase() === 'p') {
      e.preventDefault()
      console.log('[freeze-ipc] 宿主焦点 Alt+P → toggleFreeze')
      win.webContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'toggleFreeze' })
    }
  })
}

export function registerFreezeIpc(): void {
  // freeze-manager 内部触发的状态变化（Alt+P 恢复 / 窗口失焦自动恢复）广播到渲染层
  setFreezeStateBroadcaster((tabId, state) => broadcastFreezeState(tabId, state))
  setWebviewDestroyedHandler((record) => {
    if (clearDestroyedFreezeSession(record.tabId, record.webContentsId)) {
      broadcastFreezeState(record.tabId, 'idle')
    }
  })

  // 宿主 Alt+P 拦截：焦点在宿主 UI 区域（选择层聚焦后）时快捷键仍可触发
  for (const w of BrowserWindow.getAllWindows()) attachHostAltPHotkey(w)
  app.on('browser-window-created', (_e, w) => attachHostAltPHotkey(w))

  // 注册 webview 到冻结注册表（渲染层在 webview attach 后上报）
  ipcMain.handle(
    IPC_CHANNELS.FREEZE_REGISTER_WEBVIEW,
    (
      _e: IpcMainInvokeEvent,
      payload: { tabId: string; windowId: string; profileId: string; webContentsId: number },
    ) => {
      // 用 webContentsId 反查（did-attach-webview 时渲染层上报的 id）
      const target = webContents.fromId(payload.webContentsId)
      if (!target || target.isDestroyed()) {
        console.warn('[freeze-ipc] 注册失败：webContents 不存在', payload.webContentsId)
        return false
      }
      registerWebview(target, {
        tabId: payload.tabId,
        windowId: payload.windowId,
        profileId: payload.profileId,
      })
      return true
    },
  )

  // 冻结指定 tab：抓取对话快照 → 提取文本层 → pause 冻结 → 后台入库
  ipcMain.handle(
    IPC_CHANNELS.FREEZE_TAB,
    async (
      _e: IpcMainInvokeEvent,
      payload: { tabId: string; profileId: string },
    ): Promise<FreezeActionResult> => runTabOperation(payload.tabId, () => performFreeze(payload)),
  )

  ipcMain.handle(
    IPC_CHANNELS.FREEZE_TOGGLE,
    async (
      _e: IpcMainInvokeEvent,
      payload: { tabId: string; profileId: string },
    ): Promise<FreezeActionResult> => runTabOperation(payload.tabId, () => performToggle(payload)),
  )

  // 恢复指定 tab
  ipcMain.handle(
    IPC_CHANNELS.FREEZE_RESUME,
    async (_e: IpcMainInvokeEvent, tabId: string): Promise<boolean> => {
      const result = await runTabOperation(tabId, () => performResume(tabId))
      return result.state === 'attached'
    },
  )

  // 彻底分离调试器
  ipcMain.handle(
    IPC_CHANNELS.FREEZE_DETACH,
    (_e: IpcMainInvokeEvent, tabId: string): Promise<boolean> => runSerializedTabOperation(tabId, async () => {
      const ok = await detachTab(tabId)
      if (ok) broadcastFreezeState(tabId, 'idle')
      return ok
    }),
  )

  // 查询冻结状态
  ipcMain.handle(
    IPC_CHANNELS.FREEZE_STATUS,
    (_e: IpcMainInvokeEvent, tabId: string): string => {
      return getFreezeState(tabId)
    },
  )

  // 冻结态滚动：渲染层选择层收到滚轮 → 主进程转发给 guest（compositor 滚动画面）
  // 冻结画面内容不动，仅视口移动；文本层偏移由渲染层按 deltaY 累计
  ipcMain.handle(
    IPC_CHANNELS.FREEZE_SCROLL,
    (
      _e: IpcMainInvokeEvent,
      payload: { tabId: string; x: number; y: number; deltaX: number; deltaY: number },
    ): Promise<FreezeScrollResult | null> => runScrollOperation(payload.tabId, async () => {
      const wc = getWebviewByTabId(payload.tabId)
      if (!wc || wc.isDestroyed() || !isFrozen(payload.tabId)) return null
      try {
        await Promise.race([
          wc.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: Math.max(0, payload.x),
            y: Math.max(0, payload.y),
            deltaX: payload.deltaX || 0,
            deltaY: payload.deltaY || 0,
          }),
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error('冻结态滚轮转发超时')), 500)
          }),
        ])
        await new Promise((resolve) => setTimeout(resolve, 64))
        const metrics = await Promise.race([
          wc.debugger.sendCommand('Page.getLayoutMetrics'),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
        ])
        if (!metrics) return null
        const viewport = metrics.cssVisualViewport || metrics.visualViewport
        return {
          scrollOffsetX: Number(viewport?.pageX) || 0,
          scrollOffsetY: Number(viewport?.pageY) || 0,
        }
      } catch {
        return null
      }
    }),
  )

  // 冻结态复制：渲染层选择层计算选中文本 → 主进程写入系统剪贴板（应用内置）
  ipcMain.on(IPC_CHANNELS.FREEZE_COPY_TEXT, (_e: IpcMainInvokeEvent, text: string) => {
    if (text && typeof text === 'string' && text.trim()) {
      clipboard.writeText(text)
      console.log('[freeze-ipc] 应用内置复制:', text.length, '字符')
    }
  })
}
