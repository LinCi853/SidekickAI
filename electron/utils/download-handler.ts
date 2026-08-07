// electron/utils/download-handler.ts — 下载事件处理 + 缓存自动清理
//
// 提供：
//   - attachDownloadHandler(ses)：为指定 session 注册 will-download 监听
//     根据 AppSettings.downloadBehavior (ask/auto) 与 downloadDir 决定保存路径
//   - maybeAutoCleanCache()：启动时按 cacheAutoClean 频率判定是否触发自动清理
//   - attachDownloadHandlersForAllProfiles()：批量挂载到所有 profile partitions
//
// 抽离到独立模块避免 main.ts 与 profile-store.ts 循环依赖。

import { app, BrowserWindow, dialog, session, type Session, type DownloadItem } from 'electron'
import path from 'path'
import { randomUUID } from 'crypto'
import { IPC_CHANNELS } from '../shared/types.js'
import { getAppSettings, updateAppSettings } from '../store/app-settings-store.js'
import { profileStore } from '../store/profile-store.js'
import { browserDownloadStore } from '../store/browser-download-store.js'

/**
 * 为指定 session 注册 will-download 监听。
 *
 * 行为：
 *   - downloadBehavior='auto' 且 downloadDir 非空：直接保存到 downloadDir/<filename>，
 *     若同名文件已存在自动追加序号（Electron 默认行为）
 *   - downloadBehavior='ask'：弹出系统保存对话框（默认目录为 downloadDir 或系统下载目录）
 *   - downloadDir 为空串：回落到 app.getPath('downloads')
 *
 * 下载完成后向所有窗口广播 APP_DOWNLOAD_DONE，UI 层可据此显示 toast。
 *
 * @param ses 要挂载的 session（defaultSession 或 persist:<profileId> partition）
 */
export function attachDownloadHandler(ses: Session, profileId?: string): void {
  // 避免重复挂载（同一 session 多次调用会叠加监听器）
  if ((ses as unknown as { __downloadHandlerAttached?: boolean }).__downloadHandlerAttached) {
    return
  }
  ;(ses as unknown as { __downloadHandlerAttached?: boolean }).__downloadHandlerAttached = true

  // profileId 由调用方传入；未传入时回退为 'default'
  const resolvedProfileId = profileId || 'default'

  ses.on('will-download', async (_e, item: DownloadItem) => {
    const settings = getAppSettings()
    const dir = settings.downloadDir || app.getPath('downloads')
    const filename = item.getFilename() || 'download'

    let savePath: string
    if (settings.downloadBehavior === 'auto' && dir) {
      // 自动保存到指定目录
      savePath = path.join(dir, filename)
      item.setSavePath(savePath)
    } else {
      // 每次询问：弹保存框（默认目录为 downloadDir 或系统下载目录）
      try {
        const result = await dialog.showSaveDialog({
          defaultPath: path.join(dir, filename),
        })
        if (result.canceled || !result.filePath) {
          item.cancel()
          return
        }
        savePath = result.filePath
        item.setSavePath(savePath)
      } catch (err) {
        console.error('[download-handler] 保存对话框失败:', err)
        item.cancel()
        return
      }
    }

    // 写入下载记录到存储
    const downloadId = randomUUID()
    const startTime = Date.now()
    try {
      browserDownloadStore.add({
        id: downloadId,
        windowId: 'main',
        profileId: resolvedProfileId,
        url: item.getURL(),
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
      windowId: 'main',
      profileId: resolvedProfileId,
      url: item.getURL(),
      filename,
      savePath,
      state: 'progressing',
      totalBytes: item.getTotalBytes(),
      receivedBytes: 0,
      startTime,
    })

    // 监听下载进度
    item.on('updated', (_e2, state) => {
      if (state === 'progressing') {
        const received = item.getReceivedBytes()
        const total = item.getTotalBytes()
        try {
          browserDownloadStore.update(downloadId, { receivedBytes: received, totalBytes: total, state: 'progressing' })
        } catch { /* ignore */ }
        broadcastDownload({
          id: downloadId,
          windowId: 'main',
          profileId: resolvedProfileId,
          url: item.getURL(),
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
      const finalState = state === 'completed' ? 'completed' : state === 'interrupted' ? 'interrupted' : 'cancelled'
      // 更新存储
      try {
        browserDownloadStore.update(downloadId, {
          state: finalState,
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes(),
          endTime,
        })
      } catch { /* ignore */ }
      // 广播下载状态更新
      broadcastDownload({
        id: downloadId,
        windowId: 'main',
        profileId: resolvedProfileId,
        url: item.getURL(),
        filename,
        savePath,
        state: finalState,
        totalBytes: item.getTotalBytes(),
        receivedBytes: item.getReceivedBytes(),
        startTime,
        endTime,
      })
      // 兼容旧逻辑：completed 时广播 APP_DOWNLOAD_DONE
      if (state === 'completed') {
        const info = { filename: item.getFilename(), path: item.getSavePath() }
        console.log('[download-handler] 下载完成:', info)
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) {
            try {
              w.webContents.send(IPC_CHANNELS.APP_DOWNLOAD_DONE, info)
            } catch { /* ignore */ }
          }
        }
      } else if (state === 'interrupted') {
        console.warn('[download-handler] 下载中断:', item.getFilename())
      }
    })
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
      } catch { /* ignore */ }
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
      } catch { /* ignore */ }
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
    s.cacheAutoClean === 'daily' ? 86_400_000
    : s.cacheAutoClean === 'weekly' ? 604_800_000
    : 2_592_000_000 // monthly (30 days)

  if (now - last < interval) return

  try {
    const { cleanCacheData } = await import('../store/backup-restore.js')
    const result = await cleanCacheData()
    updateAppSettings({ lastCacheCleanAt: now })
    console.log('[download-handler] 自动缓存清理完成，已清理:', result.cleanedBytes, '字节')
  } catch (e) {
    console.warn('[download-handler] 自动缓存清理失败:', e)
  }
}
