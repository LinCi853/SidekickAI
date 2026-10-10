// electron/ipc/browser-ipc.ts — 浏览器窗口 IPC 注册
//
// v0.0.9：多标签浏览器窗口相关 IPC handler。
// 包含：窗口状态 CRUD / 标签操作 / 外部打开 / 搜索历史 / 下载 / 导航历史
//
// 在 app.whenReady 后由 main.ts 调用 registerBrowserIpc(deps) 完成注册。
//
// 已迁移到统一注入管线：使用 EffectScope 管理 IPC handler 生命周期。

import { ipcMain, shell, BrowserWindow, dialog, screen, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import { markAskSavePath } from '../utils/ask-save-path.js'
import { enterCloudPc, exitCloudPc } from '../utils/cloud-pc.js'
import fs from 'fs'
import { assertTrustedRenderer } from '../security/trusted-renderer.js'
import { ownedProfileSession, ownedWebContents } from '../security/webview-owner.js'
import { httpUrl, withPublicResponse } from '../security/public-request.js'
import { createPdfPreview, readPdfPreview, deletePdfPreview } from '../utils/pdf-protocol.js'
import { openNativeFile } from '../security/native-file.js'

import type {
  BrowserWindowState,
  BrowserTabState,
  BrowserDownloadRecord,
  SearchHistoryEntry,
} from '../shared/types.js'
import type { BookmarkInput, BookmarkFilter, BookmarkPatch } from '../shared/bookmark.types.js'
import { browserWindowStore } from '../store/browser-window-store.js'
import { bookmarkStore } from '../store/bookmark-store.js'
import { windowStore, MAIN_WINDOW_ID } from '../store/window-store.js'
import { windowState } from '../window-state.js'
import { findWindowIdByWin } from '../window-factory.js'
import { isTrackedFullscreen } from '../utils/fullscreen-tracker.js'
import type { EffectScope } from '../modules/effect-scope.js'

/** 由 main.ts 注入的依赖（避免循环引用） */
export interface BrowserIpcDeps {
  /** 创建浏览器窗口 */
  createBrowserWindow: (windowId: string, profileId: string) => BrowserWindow
  /** 获取搜索历史 store（Phase 6 注入，可选） */
  getSearchHistoryStore?: () => {
    add: (entry: { profileId: string; query: string; url: string }) => void
    list: (profileId: string, keyword?: string, limit?: number) => SearchHistoryEntry[]
  } | null
  /** 获取下载 store（Phase 6 注入，可选） */
  getDownloadStore?: () => {
    list: (windowId?: string, limit?: number) => BrowserDownloadRecord[]
    get: (id: string) => BrowserDownloadRecord | null
    delete: (id: string) => void
    clearAll: (windowId?: string) => void
  } | null
}

/** 获取调用方所在的 BrowserWindow */
function getSenderWindow(e: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(e.sender)
}

/**
 * 注册浏览器窗口相关 IPC handler。
 *
 * 已迁移到统一注入管线：使用 EffectScope.ipcHandle() 注册，保证模块 teardown 时自动清理。
 */
export function registerBrowserIpc(deps: BrowserIpcDeps, scope?: EffectScope): void {
  // 辅助函数：根据是否有 scope 选择注册方式
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = scope
    ? (channel: string, fn: (...args: any[]) => any) => scope.ipcHandle(channel, fn as any)
    : (channel: string, fn: (...args: any[]) => any) => ipcMain.handle(channel, fn as any)

  // ===== 窗口状态 =====

  handle(IPC_CHANNELS.BROWSER_GET_STATE, (_e, windowId: string) => {
    return browserWindowStore.get(windowId)
  })

  handle(IPC_CHANNELS.BROWSER_SAVE_STATE, (_e, windowId: string, state: BrowserWindowState) => {
    browserWindowStore.save(windowId, state)
  })

  // ===== 标签操作 =====

  handle(IPC_CHANNELS.BROWSER_NEW_TAB, (_e, windowId: string, tab: BrowserTabState) => {
    const state = browserWindowStore.get(windowId)
    if (!state) return
    state.tabs.push(tab)
    state.activeTabId = tab.id
    browserWindowStore.save(windowId, state)
  })

  handle(IPC_CHANNELS.BROWSER_CLOSE_TAB, (_e, windowId: string, tabId: string) => {
    const state = browserWindowStore.get(windowId)
    if (!state) return
    state.tabs = state.tabs.filter((t) => t.id !== tabId)
    if (state.activeTabId === tabId) {
      state.activeTabId = state.tabs.length > 0 ? state.tabs[state.tabs.length - 1].id : null
    }
    browserWindowStore.save(windowId, state)
  })

  handle(IPC_CHANNELS.BROWSER_SWITCH_TAB, (_e, windowId: string, tabId: string) => {
    const state = browserWindowStore.get(windowId)
    if (!state) return
    state.activeTabId = tabId
    browserWindowStore.save(windowId, state)
  })

  handle(IPC_CHANNELS.BROWSER_NAVIGATE, (_e, windowId: string, tabId: string, url: string) => {
    const state = browserWindowStore.get(windowId)
    if (!state) return
    state.tabs = state.tabs.map((t) =>
      t.id === tabId ? { ...t, url } : t,
    )
    browserWindowStore.save(windowId, state)
  })

  // ===== 全局光标坐标（全屏悬浮退出条的光标探测） =====
  handle(IPC_CHANNELS.BROWSER_CURSOR_POS, () => {
    try {
      const p = screen.getCursorScreenPoint()
      return { ok: true, x: p.x, y: p.y }
    } catch {
      return { ok: false, x: 0, y: 0 }
    }
  })

  // ===== 云电脑模式 =====
  handle(IPC_CHANNELS.BROWSER_CLOUD_PC_SET, (e, enter: boolean) => {
    const win = getSenderWindow(e as IpcMainInvokeEvent)
    if (!win || win.isDestroyed()) return { ok: false }
    if (enter) {
      // 进入云电脑模式前保存 bounds（云电脑要求全屏）
      const wid = findWindowIdByWin(win)
      const wasFs = wid ? isTrackedFullscreen(wid) : win.isFullScreen()
      if (!wasFs) {
        if (wid) {
          const state = windowStore.getOrDefault(wid)
          state.fullscreenNormalBounds = win.getBounds()
          windowStore.save(wid, state)
        }
      }
      enterCloudPc(win.webContents.id, win)
      try {
        if (!wasFs) win.setFullScreen(true)
      } catch { /* ignore */ }
    } else {
      exitCloudPc(win.webContents.id)
      const wid = findWindowIdByWin(win)
      const wasFs = wid ? isTrackedFullscreen(wid) : win.isFullScreen()
      try {
        if (wasFs) win.setFullScreen(false)
      } catch { /* ignore */ }
    }
    try {
      win.webContents.send(IPC_CHANNELS.BROWSER_CLOUD_PC_CHANGED, enter)
    } catch { /* ignore */ }
    return { ok: true }
  })

  // ===== 外部浏览器打开 =====

  handle(IPC_CHANNELS.BROWSER_OPEN_EXTERNAL, (event, url: string) => {
    assertTrustedRenderer(event)
    return shell.openExternal(httpUrl(url).href)
  })

  // ===== 另存为（页面 / 链接 / 图片） =====

  // 另存为当前页面：主进程弹保存对话框后以 HTMLComplete 格式保存
  handle(IPC_CHANNELS.BROWSER_SAVE_PAGE_AS, async (e, webContentsId: number, suggestedName?: string) => {
    const wc = ownedWebContents(e, webContentsId)
    const win = BrowserWindow.fromWebContents(wc) ?? getSenderWindow(e as IpcMainInvokeEvent)
    if (!win || win.isDestroyed()) return { ok: false, error: 'window not found' }
    const url = wc.getURL() || ''
    // 仅允许保存可另存为的页面（http/https/file/data；view-source 等内部协议跳过）
    if (!/^(https?:|file:|data:)/i.test(url)) return { ok: false, error: 'unsupported url' }

    // 默认文件名：优先渲染层建议名（页面标题），再回退 'page'；无扩展名补 .html
    let defaultName = (suggestedName || '').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 120)
    if (!defaultName) defaultName = 'page'
    if (!/\.[a-z0-9]{1,5}$/i.test(defaultName)) defaultName += '.html'

    const result = dialog.showSaveDialogSync(win, {
      title: '另存为',
      defaultPath: defaultName,
      filters: [
        { name: 'HTML 文件', extensions: ['html', 'htm'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    if (!result) return { ok: false, canceled: true }
    try {
      await wc.savePage(result, 'HTMLComplete')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // 另存为链接/图片：标记一次性「询问保存路径」后触发下载，will-download 中弹保存对话框
  // partition 为 webview 的 session 分区（persist:profileId），与下载记录注册的 session 一致
  handle(IPC_CHANNELS.BROWSER_DOWNLOAD_AS, (event, partition: string, url: string, _suggestedFilename?: string) => {
    if (!/^(https?:|data:|blob:)/i.test(url)) return { ok: false, error: 'invalid url' }
    let cancelSaveIntent: (() => void) | undefined
    try {
      const initiatingSession = ownedProfileSession(event, partition)
      cancelSaveIntent = markAskSavePath(initiatingSession, url)
      initiatingSession.downloadURL(url)
      return { ok: true }
    } catch (err) {
      cancelSaveIntent?.()
      return { ok: false, error: String(err) }
    }
  })

  // ===== 查看网页源代码 =====
  // Source reads retain session cookies and validate every network destination.
  handle(IPC_CHANNELS.BROWSER_VIEW_SOURCE, async (event, partition: string, url: string) => {
    try {
      const ses = ownedProfileSession(event, partition)
      return await withPublicResponse(ses, url, AbortSignal.timeout(30000), async response => {
        if (response.statusCode < 200 || response.statusCode >= 300) throw new Error('HTTP ' + response.statusCode)
        const limit = 3 * 1024 * 1024
        const chunks: Buffer[] = []
        let size = 0, truncated = false
        for await (const chunk of response.body) {
          const bytes = Buffer.from(chunk)
          const remaining = limit - size
          chunks.push(bytes.subarray(0, remaining))
          size += Math.min(bytes.length, remaining)
          if (bytes.length > remaining) { truncated = true; break }
        }
        const html = Buffer.concat(chunks).toString('utf8') + (truncated ? '\n<!-- 源码过大已截断 -->' : '')
        return { ok: true, html, contentType: response.headers['content-type'] || 'text/html' }
      })
    } catch (err) { return { ok: false, error: String(err) } }
  })
  handle(IPC_CHANNELS.BROWSER_PRINT_PREVIEW, async (event, webContentsId: number, title?: string) => {
    try {
      const wc = ownedWebContents(event, webContentsId)
      const pdf = await wc.printToPDF({ printBackground: true, preferCSSPageSize: true })
      assertTrustedRenderer(event)
      const safeTitle = (typeof title === 'string' ? title : 'page').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'page'
      return { ok: true, filePath: createPdfPreview(pdf, event.sender), title: safeTitle }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  handle(IPC_CHANNELS.BROWSER_SAVE_PDF_AS, (event, token: string, suggestedName?: string) => {
    try {
      assertTrustedRenderer(event)
      const bytes = readPdfPreview(token, event.sender)
      const win = getSenderWindow(event)!
      const defaultName = (typeof suggestedName === 'string' ? suggestedName : 'page').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) + '.pdf'
      const selected = dialog.showSaveDialogSync(win, { title: '另存为 PDF', defaultPath: defaultName,
        filters: [{ name: 'PDF 文件', extensions: ['pdf'] }, { name: '所有文件', extensions: ['*'] }] })
      if (!selected) return { ok: false, canceled: true }
      const file = openNativeFile(selected, true)
      try {
        fs.writeFileSync(file.descriptor, bytes)
        fs.ftruncateSync(file.descriptor, bytes.length)
        fs.fsyncSync(file.descriptor)
      } finally { fs.closeSync(file.descriptor) }
      return { ok: true }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  handle(IPC_CHANNELS.BROWSER_DELETE_TEMP_PDF, (event, token: string) => {
    try {
      assertTrustedRenderer(event)
      return { ok: deletePdfPreview(token, event.sender) }
    } catch { return { ok: false } }
  })
  // ===== 网页截图 =====
  // 保存截图 PNG（渲染层 capturePage 的 dataURL）到用户指定路径
  handle(IPC_CHANNELS.BROWSER_SAVE_CAPTURE, (e, dataUrl: string, suggestedName?: string) => {
    if (!dataUrl || !dataUrl.startsWith('data:image/')) return { ok: false, error: 'invalid image data' }
    const win = getSenderWindow(e as IpcMainInvokeEvent)
    if (!win || win.isDestroyed()) return { ok: false, error: 'window not found' }
    const defaultName = (suggestedName || '截图').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) + '.png'
    const result = dialog.showSaveDialogSync(win, {
      title: '保存截图',
      defaultPath: defaultName,
      filters: [{ name: 'PNG 图片', extensions: ['png'] }, { name: '所有文件', extensions: ['*'] }],
    })
    if (!result) return { ok: false, canceled: true }
    try {
      const base64 = dataUrl.split(',')[1] || ''
      fs.writeFileSync(result, Buffer.from(base64, 'base64'))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // ===== 搜索历史 =====

  handle(IPC_CHANNELS.BROWSER_SEARCH_HISTORY_ADD, (_e, entry: { profileId: string; query: string; url: string }) => {
    const store = deps.getSearchHistoryStore?.()
    if (store) store.add(entry)
  })

  handle(IPC_CHANNELS.BROWSER_SEARCH_HISTORY_LIST, (_e, profileId: string, keyword?: string, limit?: number) => {
    const store = deps.getSearchHistoryStore?.()
    return store ? store.list(profileId, keyword, limit) : []
  })

  // ===== 下载记录 =====

  handle(IPC_CHANNELS.BROWSER_DOWNLOAD_LIST, (_e, windowId?: string, limit?: number) => {
    const store = deps.getDownloadStore?.()
    return store ? store.list(windowId, limit) : []
  })

  handle(IPC_CHANNELS.BROWSER_DOWNLOAD_OPEN_FILE, async (_e, id: string) => {
    const store = deps.getDownloadStore?.()
    if (!store) return { ok: false, error: 'download store not available' }
    const record = store.get(id)
    if (!record) return { ok: false, error: 'record not found' }
    try {
      await shell.openPath(record.savePath)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  handle(IPC_CHANNELS.BROWSER_DOWNLOAD_SHOW_IN_FOLDER, (_e, id: string) => {
    const store = deps.getDownloadStore?.()
    if (!store) return { ok: false, error: 'download store not available' }
    const record = store.get(id)
    if (!record) return { ok: false, error: 'record not found' }
    try {
      shell.showItemInFolder(record.savePath)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  handle(IPC_CHANNELS.BROWSER_DOWNLOAD_DELETE, (_e, id: string) => {
    const store = deps.getDownloadStore?.()
    if (!store) return { ok: false, error: 'download store not available' }
    try {
      store.delete(id)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  handle(IPC_CHANNELS.BROWSER_DOWNLOAD_CLEAR_ALL, (_e, windowId?: string) => {
    const store = deps.getDownloadStore?.()
    if (!store) return { ok: false, error: 'download store not available' }
    try {
      store.clearAll(windowId)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // ===== 书签系统（v0.0.9） =====

  handle(IPC_CHANNELS.BOOKMARK_LIST, (_e, filter?: BookmarkFilter) => {
    return bookmarkStore.list(filter)
  })

  // 书签写路径必须来自应用窗口（与 BROWSER_OPEN_EXTERNAL 一致）
  handle(IPC_CHANNELS.BOOKMARK_ADD, (e, input: BookmarkInput) => {
    assertTrustedRenderer(e)
    return bookmarkStore.add(input)
  })

  handle(IPC_CHANNELS.BOOKMARK_UPDATE, (e, id: string, patch: BookmarkPatch) => {
    assertTrustedRenderer(e)
    return bookmarkStore.update(id, patch)
  })

  handle(IPC_CHANNELS.BOOKMARK_DELETE, (e, id: string) => {
    assertTrustedRenderer(e)
    bookmarkStore.delete(id)
  })

  handle(IPC_CHANNELS.BOOKMARK_REORDER, (e, ids: string[]) => {
    assertTrustedRenderer(e)
    bookmarkStore.reorder(ids)
  })

  // ===== 聚焦浏览器窗口 =====
  handle(IPC_CHANNELS.BROWSER_FOCUS_WINDOW, (_e, windowId: string) => {
    const win = windowState.detachedWindows.get(windowId)
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      if (!win.isVisible()) win.show()
      win.focus()
      return true
    }
    return false
  })

  // ===== 跨窗口标签聚合查询（v0.0.9，主子标签归属） =====

  handle(IPC_CHANNELS.BROWSER_TABS_QUERY, () => {
    // 聚合主窗口标签 + 所有浏览器窗口标签，返回树结构
    // 主窗口标签（TabState[]，含 detachedWindowId 标记哪些已脱离）
    const mainWindowState = windowStore.get(MAIN_WINDOW_ID)
    const mainTabs = mainWindowState?.tabs ?? []
    // 所有浏览器窗口（BrowserWindowState[]，含 parentTabId 关联到主窗口标签）
    const browsers = browserWindowStore.list().map((state) => ({
      windowId: state.windowId,
      parentTabId: state.parentTabId ?? null,
      profileId: state.profileId,
      platformName: state.platformName ?? null,
      tabs: state.tabs,
    }))
    return { main: mainTabs, browsers }
  })
}
