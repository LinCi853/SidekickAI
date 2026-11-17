// electron/browser/download-handler.ts — 下载事件处理 + 缓存自动清理
//
// 提供：
//   - attachDownloadHandler(ses)：为指定 session 注册唯一的 will-download 监听
//     根据 AppSettings.downloadBehavior (ask/auto) 与 downloadDir 决定保存路径
//   - maybeAutoCleanCache()：启动时按 cacheAutoClean 频率判定是否触发自动清理
//   - attachDownloadHandlersForAllProfiles()：批量挂载到所有 profile partitions
//
// 每个 session 只允许一个 will-download 监听。历史实现里本模块与 browser-downloads.ts
// 各自注册了一个监听，且两者使用不同的去重标记，导致同一次保存会弹出两个“另存为”
// 对话框（一个无父窗口、标题显示 URL，一个挂在浏览器窗口上），两次 setSavePath
// 相互覆盖并写出两条下载记录。现统一由本模块处理。
//
// 保存路径必须在 will-download 回调内同步设置，否则 Electron 会退回系统自带的保存框。
// 因此“每次询问”走两步：先取消本次下载，等用户在应用内弹窗选定路径后按该路径重新下载。

import { BrowserWindow, session, type Session, type DownloadItem, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import path from 'node:path'
import { IPC_CHANNELS } from '../shared/types.js'
import { getAppSettings } from '../store/app-settings-repository.js'
import { updateAppSettings } from '../store/app-settings-store.js'
import { resolveSaveDirectory } from '../store/default-save-location.js'
import { resolveDownloadSettings, rememberDownloadDefault } from './download-settings.js'
import { profileStore } from './profile-store.js'
import { browserDownloadStore } from './browser-download-store.js'
import { containedDownloadPath, safeDownloadFilename } from '../platform/security/download-path.js'
import { installProfilePermissions } from '../platform/security/session-permissions.js'
import { showSaveDialog } from './save-dialog.js'
import { getRecordByWebContentsId } from './webview-registry.js'
import { windowState } from '../platform/window/window-state.js'
import { findWindowIdByWin } from '../platform/window/window-utils.js'

const activeDownloads = new Set<DownloadItem>()

/** 已注册下载监听的 session，保证一个 session 只有一个 will-download 监听 */
const attachedSessions = new WeakSet<Session>()

/** 等待用户确认的保存弹窗数量（应用退出前需要等待） */
let pendingSaveDialogs = 0

/** 已选定但尚未落盘的保存路径：session -> 原始请求 URL -> 目标路径与发起窗口 */
const pendingSavePaths = new WeakMap<
  Session,
  Map<string, { path: string; windowId: string; expiresAt: number }>
>()

/** 用户选定路径后的重新下载有效期（秒） */
const PENDING_SAVE_TTL_MS = 60_000

/** Protect live transfers, including paused items and the save dialog. */
export function hasActiveDownloads(): boolean {
  return activeDownloads.size > 0 || pendingSaveDialogs > 0
}

/** 记录用户已选定的保存路径，供取消后重新下载时同步设置 */
function setPendingSavePath(ses: Session, url: string, savePath: string, windowId: string): void {
  const pending = pendingSavePaths.get(ses) ?? new Map()
  pending.set(url, { path: savePath, windowId, expiresAt: Date.now() + PENDING_SAVE_TTL_MS })
  pendingSavePaths.set(ses, pending)
}

/** 取走用户已选定的保存路径（一次性） */
function takePendingSavePath(
  ses: Session,
  url: string,
): { path: string; windowId: string } | undefined {
  const pending = pendingSavePaths.get(ses)
  if (!pending) return undefined
  const entry = pending.get(url)
  if (!entry) return undefined
  pending.delete(url)
  if (!pending.size) pendingSavePaths.delete(ses)
  if (Date.now() >= entry.expiresAt) return undefined
  return { path: entry.path, windowId: entry.windowId }
}

/**
 * 定位下载的发起窗口，用于把保存对话框挂到正确的窗口上并记录窗口归属。
 * 优先使用发起下载的 guest 所属宿主窗口；无法定位时回落到该 profile 的浏览器窗口。
 */
function resolveDownloadOwner(
  profileId: string,
  source?: WebContents,
): { win: BrowserWindow; windowId: string } | null {
  if (source) {
    if (source.isDestroyed()) return null
    const record = getRecordByWebContentsId(source.id)
    if (record && record.profileId !== profileId) return null
    try {
      const host = source.hostWebContents || source
      const win = BrowserWindow.fromWebContents(host)
      if (!win || win.isDestroyed()) return null
      const windowId = findWindowIdByWin(win)
      if (!windowId || (record && record.windowId !== windowId)) return null
      return { win, windowId }
    } catch {
      return null
    }
  }
  const win = windowState.browserWindowsByProfile.get(profileId)
  if (!win || win.isDestroyed()) return null
  const windowId = findWindowIdByWin(win)
  return windowId ? { win, windowId } : null
}

/**
 * 为指定 session 注册 will-download 监听。
 *
 * 行为：
 *   - downloadBehavior='auto'：直接保存到 downloadDir/<filename>，
 *     若同名文件已存在自动追加序号（Electron 默认行为）
 *   - downloadBehavior='ask'：先取消本次下载，在发起窗口弹出应用内保存弹窗，
 *     用户选定路径后按该路径重新下载（路径必须在 will-download 回调内同步设置）
 *   - downloadDir 为空串：回落到 app.getPath('downloads')
 *
 * 下载完成后向所有窗口广播 APP_DOWNLOAD_DONE，UI 层可据此显示 toast。
 *
 * @param ses 要挂载的 session（persist:<profileId> partition）
 */
export function attachDownloadHandler(ses: Session, profileId?: string): void {
  if (profileId) installProfilePermissions(ses, profileId)
  // 避免重复挂载（同一 session 多次调用会叠加监听器）
  if (attachedSessions.has(ses)) return
  attachedSessions.add(ses)

  // profileId 由调用方传入；未传入时回退为 'default'
  const resolvedProfileId = profileId || 'default'

  ses.on('will-download', (event, item: DownloadItem, source?: WebContents) => {
    const url = item.getURLChain?.()[0] || item.getURL()

    // 用户已在弹窗里选定路径：同步落盘
    const chosen = takePendingSavePath(ses, url)
    if (chosen) {
      item.setSavePath(chosen.path)
      trackDownload(item, {
        profileId: resolvedProfileId,
        url: item.getURL(),
        filename: path.basename(chosen.path),
        savePath: chosen.path,
        windowId:
          chosen.windowId || resolveDownloadOwner(resolvedProfileId, source)?.windowId || '',
      })
      return
    }

    const override = profileStore.get(resolvedProfileId)?.downloadSettings
    const settings = resolveDownloadSettings(override)
    const filename = safeDownloadFilename(item.getFilename())
    const owner = resolveDownloadOwner(resolvedProfileId, source)

    if (settings.downloadBehavior === 'auto') {
      // 自动保存到指定目录：路径同步设置，下载立即开始
      let savePath: string
      try {
        savePath = containedDownloadPath(settings.downloadDir, filename)
      } catch {
        savePath = path.join(resolveSaveDirectory(''), filename)
      }
      item.setSavePath(savePath)
      trackDownload(item, {
        profileId: resolvedProfileId,
        url: item.getURL(),
        filename,
        savePath,
        windowId: owner?.windowId || '',
      })
      return
    }

    // 每次询问：取消本次下载，等用户在应用内弹窗选定路径后按该路径重新下载。
    // （保存路径必须在 will-download 回调内同步设置，否则 Electron 会弹出系统自带保存框）
    event.preventDefault()
    pendingSaveDialogs += 1
    void showSaveDialog(owner?.win ?? null, {
      title: '另存为',
      fileName: filename,
      directory: settings.downloadDir,
      filters: [{ name: '所有文件', extensions: ['*'] }],
    })
      .then(async (outcome) => {
        if (outcome.action !== 'save' || !outcome.filePath) return
        // 勾选“以后保存到此位置”：写回当前生效的那一层设置，之后同类保存不再询问
        if (outcome.remember) {
          await rememberDownloadDefault(
            {
              override,
              saveOverride: (next) =>
                profileStore.update(resolvedProfileId, { downloadSettings: next }),
            },
            path.dirname(outcome.filePath),
          )
        }
        setPendingSavePath(ses, url, outcome.filePath, owner?.windowId || '')
        ses.downloadURL(url)
      })
      .catch((err) => {
        console.error('[download-handler] 保存弹窗失败:', err)
      })
      .finally(() => {
        pendingSaveDialogs -= 1
      })
  })
}

/** 记录下载并广播进度与完成事件 */
function trackDownload(
  item: DownloadItem,
  context: {
    profileId: string
    url: string
    filename: string
    savePath: string
    windowId: string
  },
): void {
  const { profileId, url, filename, savePath, windowId } = context
  activeDownloads.add(item)
  item.once('done', () => activeDownloads.delete(item))

  // 写入下载记录到存储
  const downloadId = randomUUID()
  const startTime = Date.now()
  try {
    browserDownloadStore.add({
      id: downloadId,
      windowId,
      profileId,
      url,
      filename,
      savePath,
      state: 'progressing',
      totalBytes: item.getTotalBytes(),
      receivedBytes: 0,
      startTime,
    })
  } catch (err) {
    console.error('[download-handler] 写入下载记录失败:', err)
  }

  // 广播下载开始事件给所有窗口
  broadcastDownload({
    id: downloadId,
    windowId,
    profileId,
    url,
    filename,
    savePath,
    state: 'progressing',
    totalBytes: item.getTotalBytes(),
    receivedBytes: 0,
    startTime,
  })

  // 监听下载进度：updated 事件按下载速率高频触发，每次都做同步 sqlite 读写
  // 并向所有窗口广播会随速度线性放大主进程负载；节流到至多每 500ms 落一次盘
  let lastProgressAt = 0
  item.on('updated', (_e2, state) => {
    if (state === 'progressing') {
      const now = Date.now()
      if (now - lastProgressAt < 500) return
      lastProgressAt = now
      const received = item.getReceivedBytes()
      const total = item.getTotalBytes()
      try {
        browserDownloadStore.update(downloadId, {
          receivedBytes: received,
          totalBytes: total,
          state: 'progressing',
        })
      } catch {
        /* ignore */
      }
      broadcastDownload({
        id: downloadId,
        windowId,
        profileId,
        url,
        filename,
        savePath,
        state: 'progressing',
        totalBytes: total,
        receivedBytes: received,
        startTime,
      })
    }
  })

  // 监听下载完成，向所有窗口广播通知
  item.once('done', (_e2, state) => {
    const endTime = Date.now()
    const finalState =
      state === 'completed' ? 'completed' : state === 'interrupted' ? 'interrupted' : 'cancelled'
    // 更新存储
    try {
      browserDownloadStore.update(downloadId, {
        state: finalState,
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        endTime,
      })
    } catch {
      /* ignore */
    }
    // 广播下载状态更新
    broadcastDownload({
      id: downloadId,
      windowId,
      profileId,
      url,
      filename,
      savePath,
      state: finalState,
      totalBytes: item.getTotalBytes(),
      receivedBytes: item.getReceivedBytes(),
      startTime,
      endTime,
    })
    // completed 时广播 APP_DOWNLOAD_DONE
    if (state === 'completed') {
      const info = { filename: item.getFilename(), path: item.getSavePath() }
      console.log('[download-handler] 下载完成:', info)
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) {
          try {
            w.webContents.send(IPC_CHANNELS.APP_DOWNLOAD_DONE, info)
          } catch {
            /* ignore */
          }
        }
      }
    } else if (state === 'interrupted') {
      console.warn('[download-handler] 下载中断:', item.getFilename())
    }
  })
}

/** 广播下载状态更新给所有窗口 */
function broadcastDownload(payload: {
  id: string
  windowId: string
  profileId: string
  url: string
  filename: string
  savePath: string
  state: string
  totalBytes: number
  receivedBytes: number
  startTime: number
  endTime?: number
}): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      try {
        w.webContents.send(IPC_CHANNELS.BROWSER_DOWNLOAD_UPDATED, payload)
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 为所有 profile partitions 批量挂载 will-download 监听。
 * 在 app.whenReady() 内、Profile 加载完成后调用一次。
 * 新建 Profile 时由 profile-store.ts 的 PROFILE_CREATE 处理器单独调用 attachDownloadHandler。
 */
export function attachDownloadHandlersForAllProfiles(): void {
  // 不挂载 defaultSession —— 主窗口本身不发起下载，
  // 所有下载均来自 webview 的 persist:<profileId> partition
  // （曾同时挂载 defaultSession 导致部分场景 will-download 双触发，出现两个下载）
  try {
    for (const profile of profileStore.list()) {
      try {
        attachDownloadHandler(session.fromPartition(`persist:${profile.id}`), profile.id)
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    console.warn('[download-handler] 批量挂载下载监听失败:', err)
  }
}

/**
 * 启动时按 cacheAutoClean 频率判定是否触发自动缓存清理。
 * 仅在 app.whenReady() 内调用一次，不引入常驻定时器。
 *
 * 判定逻辑：
 *   - cacheAutoClean='never'：直接返回
 *   - 计算 interval（daily=1d / weekly=7d / monthly=30d）
 *   - now - lastCacheCleanAt < interval：未到点，跳过
 *   - 否则触发 cleanCacheData()，更新 lastCacheCleanAt
 */
export async function maybeAutoCleanCache(): Promise<void> {
  const s = getAppSettings()
  if (s.cacheAutoClean === 'never') return

  const now = Date.now()
  const last = s.lastCacheCleanAt || 0
  const interval =
    s.cacheAutoClean === 'daily'
      ? 86_400_000
      : s.cacheAutoClean === 'weekly'
        ? 604_800_000
        : 2_592_000_000 // monthly (30 days)

  if (now - last < interval) return

  try {
    const { cleanCacheData } = await import('../store/cache-maintenance.js')
    // 休眠快照保留策略取自设置，避免自动清缓存用默认值剪掉用户保留的记录
    const result = await cleanCacheData({
      retentionDays: 7,
      maxCount: 40,
    })
    updateAppSettings({ lastCacheCleanAt: now })
    console.log('[download-handler] 自动缓存清理完成，已清理:', result.cleanedBytes, '字节')
  } catch (e) {
    console.warn('[download-handler] 自动缓存清理失败:', e)
  }
}
