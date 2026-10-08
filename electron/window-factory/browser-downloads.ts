import { BrowserWindow, session, dialog, app, type DownloadItem, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import path from 'path'
import { readSettingsRaw } from '../store/app-settings-repository.js'
import { browserDownloadStore } from '../store/browser-download-store.js'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import { consumeAskSavePath } from '../utils/ask-save-path.js'
import { getRecordByWebContentsId } from './webview-registry.js'
import { windowState } from '../window-state.js'
import { findWindowIdByWin } from './window-utils.js'

/** Publishes item progress to browser and download history windows. */
function broadcastDownloadUpdated(payload: {
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

function resolveDownloadOwner(profileId: string, source?: WebContents): { win: BrowserWindow; windowId: string } | null {
  if (source) {
    if (source.isDestroyed()) return null;
    const record = getRecordByWebContentsId(source.id);
    if (record && record.profileId !== profileId) return null;
    try {
      const host = source.hostWebContents || source;
      const win = BrowserWindow.fromWebContents(host);
      if (!win || win.isDestroyed()) return null;
      const windowId = findWindowIdByWin(win);
      if (!windowId || (record && record.windowId !== windowId)) return null;
      return { win, windowId };
    } catch { return null; }
  }
  const win = windowState.browserWindowsByProfile.get(profileId);
  if (!win || win.isDestroyed()) return null;
  const windowId = findWindowIdByWin(win);
  return windowId ? { win, windowId } : null;
}

/** Keeps one session listener and resolves the initiating window for each download. */
export function registerBrowserDownloads(profileId: string): void {
  const partition = `persist:${profileId}`
  const ses = session.fromPartition(partition)

  if ((ses as unknown as { __browserDownloadAttached?: boolean }).__browserDownloadAttached) return
  ;(ses as unknown as { __browserDownloadAttached?: boolean }).__browserDownloadAttached = true

  if (!(ses as unknown as { __permissionHandlerAttached?: boolean }).__permissionHandlerAttached) {
    ;(ses as unknown as { __permissionHandlerAttached?: boolean }).__permissionHandlerAttached = true
    ses.setPermissionRequestHandler((_webContents, permission, callback) => {
      const allowed = new Set(['media', 'geolocation', 'fullscreen', 'clipboard-read', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock', 'speaker-selection'])
      callback(allowed.has(permission))
    })
  }

  ses.on('will-download', (_e, item: DownloadItem, source?: WebContents) => {
    const owner = resolveDownloadOwner(profileId, source);
    const windowId = owner?.windowId || '';
    // Explicit saves ask for a path; ordinary downloads use the persisted directory.
    let filename: string
    let savePath: string
    const requestedUrl = item.getURLChain?.()[0] || item.getURL()
    const isAskSavePath = consumeAskSavePath(ses, requestedUrl)
    if (isAskSavePath) {
      const askFilename = (item.getFilename() || 'download').replace(/[\\/:*?"<>|]/g, '_')
      const options = {
        title: '另存为',
        defaultPath: askFilename,
        filters: [{ name: '所有文件', extensions: ['*'] }],
      };
      const result = owner
        ? dialog.showSaveDialogSync(owner.win, options)
        : dialog.showSaveDialogSync(options);
      if (!result) {
        item.cancel()
        return
      }
      filename = item.getFilename() || 'download'
      savePath = result
    } else {
      const settings = readSettingsRaw()
      const dir = settings.downloadDir || app.getPath('downloads')
      filename = item.getFilename() || 'download'
      savePath = path.join(dir, filename)
    }
    item.setSavePath(savePath)

    const downloadId = randomUUID()
    const startTime = Date.now()

    try {
      browserDownloadStore.add({
        id: downloadId,
        windowId,
        profileId,
        url: item.getURL(),
        filename,
        savePath,
        state: 'progressing',
        totalBytes: item.getTotalBytes(),
        receivedBytes: 0,
        startTime,
      })
    } catch (err) {
      console.error('[browser-downloads] Unable to persist download record:', err)
    }

    broadcastDownloadUpdated({
      id: downloadId,
      windowId,
      profileId,
      url: item.getURL(),
      filename,
      savePath,
      state: 'progressing',
      totalBytes: item.getTotalBytes(),
      receivedBytes: 0,
      startTime,
    })

    // Item listeners survive the initiating window so ongoing downloads can complete.
    item.on('updated', (_e2, state) => {
      if (state === 'progressing') {
        const received = item.getReceivedBytes()
        const total = item.getTotalBytes()
        try {
          browserDownloadStore.update(downloadId, { receivedBytes: received, totalBytes: total, state: 'progressing' })
        } catch { /* ignore */ }
        broadcastDownloadUpdated({
          id: downloadId,
          windowId,
          profileId,
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

    item.once('done', (_e2, state) => {
      const endTime = Date.now()
      const finalState = state === 'completed' ? 'completed' : state === 'interrupted' ? 'interrupted' : 'cancelled'
      try {
        browserDownloadStore.update(downloadId, {
          state: finalState,
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes(),
          endTime,
        })
      } catch { /* ignore */ }
      broadcastDownloadUpdated({
        id: downloadId,
        windowId,
        profileId,
        url: item.getURL(),
        filename,
        savePath,
        state: finalState,
        totalBytes: item.getTotalBytes(),
        receivedBytes: item.getReceivedBytes(),
        startTime,
        endTime,
      })
    })
  })
}
