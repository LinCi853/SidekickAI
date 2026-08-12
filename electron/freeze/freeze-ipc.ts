// electron/freeze/freeze-ipc.ts — 页面冻结 IPC 注册
//
// 防撤回保险：渲染层请求冻结某 tab 时，主进程先抓取该 webview 的全量对话内容入库
// （此时未冻结，executeJavaScript 可正常返回），再 Debugger.pause 冻结页面锁现场。
//
// 关键约束（PoC 验证）：冻结后 executeJavaScript 会 hang，故必须「先抓取再冻结」。

import { ipcMain, webContents, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import { registerWebview, getWebviewByTabId } from './webview-registry.js'
import {
  freezeTab,
  resumeTab,
  detachTab,
  getFreezeState,
  isFrozen,
  updateSessionRect,
} from './freeze-manager.js'

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

/** 广播冻结状态变化给所有窗口 */
function broadcastFreezeState(tabId: string, state: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      try {
        w.webContents.send(IPC_CHANNELS.FREEZE_STATE_CHANGED, { tabId, state })
      } catch {
        /* ignore */
      }
    }
  }
}

export function registerFreezeIpc(): void {
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

  // 冻结指定 tab：先抓取对话快照 → 入库 → pause 冻结
  ipcMain.handle(
    IPC_CHANNELS.FREEZE_TAB,
    async (
      _e: IpcMainInvokeEvent,
      payload: {
        tabId: string
        profileId: string
        /** webview 在窗口内的位置（CSS 像素）+ dpr，用于 uiohook 命中检测 */
        rect?: { x: number; y: number; width: number; height: number }
        dpr?: number
      },
    ): Promise<{ frozen: boolean; snapshot: FreezeSnapshot | null }> => {
      const wc = getWebviewByTabId(payload.tabId)
      if (!wc) {
        console.warn('[freeze-ipc] 冻结失败：tab webview 未找到', payload.tabId)
        return { frozen: false, snapshot: null }
      }

      // 已冻结 → 幂等返回
      if (isFrozen(payload.tabId)) {
        console.log('[freeze-ipc] tab 已冻结，幂等返回', payload.tabId)
        return { frozen: true, snapshot: null }
      }

      console.log('[freeze-ipc] 开始冻结 tab', payload.tabId, 'webContentsId=', wc.id, 'url=', wc.getURL?.())
      // 1. 先抓取对话快照（未冻结态，executeJavaScript 可正常返回）
      const snapshot = await scrapeSnapshot(wc)
      console.log('[freeze-ipc] 抓取快照完成, pairs=', snapshot?.pairs.length ?? 0)
      // 2. 入库（复用对话存储链路）
      if (snapshot && snapshot.pairs.length > 0) {
        try {
          const { getChatStore } = await import('../store/chat-store.js')
          const store = getChatStore()
          const conv = store.createConversation(
            payload.profileId,
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
          console.error('[freeze-ipc] 冻结快照入库失败:', err)
        }
      }

      // 3. pause 冻结页面
      const ok = await freezeTab(payload.tabId)
      console.log('[freeze-ipc] freezeTab 返回', ok, '当前状态', getFreezeState(payload.tabId))
      if (ok) {
        // 记录 webview 位置（uiohook 命中检测）：CSS 像素 → 物理像素
        if (payload.rect) {
          const dpr = payload.dpr || 1
          updateSessionRect(payload.tabId, {
            x: payload.rect.x * dpr,
            y: payload.rect.y * dpr,
            width: payload.rect.width * dpr,
            height: payload.rect.height * dpr,
            dpr,
          })
        }
        broadcastFreezeState(payload.tabId, 'frozen')
      }
      return { frozen: ok, snapshot }
    },
  )

  // 恢复指定 tab
  ipcMain.handle(
    IPC_CHANNELS.FREEZE_RESUME,
    async (_e: IpcMainInvokeEvent, tabId: string): Promise<boolean> => {
      const ok = await resumeTab(tabId)
      if (ok) broadcastFreezeState(tabId, 'attached')
      return ok
    },
  )

  // 彻底分离调试器
  ipcMain.handle(
    IPC_CHANNELS.FREEZE_DETACH,
    async (_e: IpcMainInvokeEvent, tabId: string): Promise<boolean> => {
      await detachTab(tabId)
      broadcastFreezeState(tabId, 'idle')
      return true
    },
  )

  // 查询冻结状态
  ipcMain.handle(
    IPC_CHANNELS.FREEZE_STATUS,
    (_e: IpcMainInvokeEvent, tabId: string): string => {
      return getFreezeState(tabId)
    },
  )

  // 渲染层上报 webview 位置（窗口 move/resize 后主进程请求，渲染层回传）
  ipcMain.on(
    IPC_CHANNELS.FREEZE_REPORT_RECT,
    (
      _e: IpcMainInvokeEvent,
      payload: { tabId: string; rect: { x: number; y: number; width: number; height: number }; dpr: number },
    ) => {
      const dpr = payload.dpr || 1
      updateSessionRect(payload.tabId, {
        x: payload.rect.x * dpr,
        y: payload.rect.y * dpr,
        width: payload.rect.width * dpr,
        height: payload.rect.height * dpr,
        dpr,
      })
    },
  )
}
