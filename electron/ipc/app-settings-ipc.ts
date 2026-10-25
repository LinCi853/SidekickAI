// electron/ipc/app-settings-ipc.ts — 应用设置 IPC 注册（含代理、备份、缓存、文件拖放）
//
// 从 app-settings-store 拆出的 IPC 枢纽：所有需要动态加载重模块的处理器集中在这里，
// 设置存储本体（app-settings-store / app-settings-repository）保持无重依赖。

import { ipcMain, app, dialog, shell } from 'electron'
import { IPC_CHANNELS } from '../shared/types.js'
import { broadcastToAllWindows } from '../shared/broadcast.js'
import { getAppSettings } from '../store/app-settings-repository.js'
import type { AppSettings } from '../store/app-settings-store.js'
import { updateAppSettings } from '../store/app-settings-store.js'
import { openActivityLogFolder } from '../store/activity-log-export.js'
import { applicationLogSources } from '../diagnostics/log-sources.js'
import type { LogExportOptions } from '../shared/log-export.js'
import { applyUiThemeBroadcast } from '../theme/native-theme-source.js'
import { reregisterProfileShortcuts } from './profile-shortcut-ipc.js'

/**
 * 向所有 BrowserWindow 广播 UI 版本 / 主题变更。
 * 任意窗口修改 Oxy Design System 开关或主题模式后，通过 IPC 调用此函数通知所有窗口同步。
 */
export function broadcastUiVersionChanged(payload: {
  uiVersion: 'classic' | 'oxy'
  theme: 'light' | 'dark' | 'system'
}): void {
  broadcastToAllWindows(IPC_CHANNELS.APP_UI_VERSION_CHANGED, payload, 'app-settings')
}

/** 注册应用设置 IPC 处理器（含代理测试与即时生效） */
export function registerAppSettingsIPC(
  exportData: typeof import('../store/backup-recovery.js').exportApplicationData,
): void {
  ipcMain.handle(IPC_CHANNELS.APP_GET_SETTINGS, () => getAppSettings())
  // 渲染层请求广播 UI 版本/主题变更到所有窗口
  ipcMain.on(
    IPC_CHANNELS.APP_UI_VERSION_CHANGED,
    (_e, payload: { uiVersion: 'classic' | 'oxy'; theme: 'light' | 'dark' | 'system' }) => {
      // 以应用内主题为准：映射到 nativeTheme.themeSource，webview 内 AI 应用随之切换
      const effective = applyUiThemeBroadcast(payload.uiVersion, payload.theme)
      if (getAppSettings().themeMode !== effective) {
        updateAppSettings({ themeMode: effective })
      }
      broadcastUiVersionChanged(payload)
    },
  )
  // 渲染层请求广播 Oxy 主题色变更到所有窗口
  ipcMain.on(IPC_CHANNELS.APP_THEME_COLOR_CHANGED, (_e, hex: string) => {
    broadcastToAllWindows(IPC_CHANNELS.APP_THEME_COLOR_CHANGED, hex, 'app-settings')
  })
  ipcMain.handle(IPC_CHANNELS.APP_UPDATE_SETTINGS, (_e, patch: Partial<AppSettings>) =>
    updateAppSettings(patch),
  )
  // 清除所有数据（恢复出厂设置）
  ipcMain.handle(IPC_CHANNELS.APP_CLEAR_ALL_DATA, async () => {
    const { clearAllData } = await import('../store/factory-reset.js')
    await clearAllData()
    return true
  })
  // 代理连通性测试
  ipcMain.handle(IPC_CHANNELS.APP_TEST_PROXY, async () => {
    // 动态导入避免循环依赖
    const { testProxyConnectivity } = await import('../store/proxy-helper.js')
    return testProxyConnectivity()
  })
  // 代理即时生效：将当前配置应用到所有 session
  ipcMain.handle(IPC_CHANNELS.APP_APPLY_PROXY, async () => {
    const { applyProxyToAllSessions } = await import('../store/proxy-helper.js')
    await applyProxyToAllSessions()
  })
  // 代理失败兜底：webview 加载失败时代理错误码触发，临时切换到兜底模式
  ipcMain.handle(IPC_CHANNELS.APP_PROXY_FALLBACK, async () => {
    const { applyProxyFallback } = await import('../store/proxy-helper.js')
    return applyProxyFallback()
  })
  // Profile 级代理测试：测试指定 Profile 的代理连通性
  ipcMain.handle(IPC_CHANNELS.APP_TEST_PROFILE_PROXY, async (_e, profileId: string) => {
    const { testProfileProxyConnectivity } = await import('../store/proxy-helper.js')
    return testProfileProxyConnectivity(profileId)
  })
  // Profile 级代理即时生效：将 Profile.proxyConfig 应用到其 session
  ipcMain.handle(IPC_CHANNELS.APP_APPLY_PROFILE_PROXY, async (_e, profileId: string) => {
    const { applyProfileProxy } = await import('../store/proxy-helper.js')
    await applyProfileProxy(profileId)
  })
  // Profile 级代理失败兜底：浏览器窗口 webview 加载失败时触发
  ipcMain.handle(IPC_CHANNELS.APP_PROFILE_PROXY_FALLBACK, async (_e, profileId: string) => {
    const { applyProxyFallback } = await import('../store/proxy-helper.js')
    return applyProxyFallback(profileId)
  })

  // 数据迁移：选择导出文件保存路径（弹出系统保存对话框）
  ipcMain.handle(IPC_CHANNELS.APP_SELECT_EXPORT_PATH, async (_e, encrypted?: boolean) => {
    const ext = encrypted ? 'sabackup' : 'zip'
    const result = await dialog.showSaveDialog({
      filters: [{ name: encrypted ? '加密备份' : 'Zip', extensions: [ext] }],
      defaultPath: `sidekickai-backup-${new Date().toISOString().slice(0, 10)}.${ext}`,
    })
    return result.canceled ? null : result.filePath
  })

  // 数据迁移：选择导入文件（弹出系统打开对话框，支持 .zip 和 .sabackup）
  ipcMain.handle(IPC_CHANNELS.APP_SELECT_IMPORT_FILE, async () => {
    const result = await dialog.showOpenDialog({
      filters: [{ name: '备份文件', extensions: ['zip', 'sabackup'] }],
      properties: ['openFile'],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // 数据迁移：导出所有数据到指定路径（细粒度控制，可选加密）
  ipcMain.handle(
    IPC_CHANNELS.APP_EXPORT_DATA,
    async (
      _e,
      targetPath: string,
      options: {
        basicData: boolean
        cookies: boolean
        indexedDB: boolean
        cache: boolean
        voiceAssets: boolean
      },
      encrypt?: { password: string },
    ) => {
      return exportData(targetPath, options, encrypt)
    },
  )

  // 数据迁移：从 zip/sabackup 文件导入所有数据（导入后应用自动重启）
  ipcMain.handle(
    IPC_CHANNELS.APP_INSPECT_BACKUP,
    async (_e, filePath: string, password?: string) => {
      const { inspectImportData } = await import('../store/backup-restore.js')
      return inspectImportData(filePath, password)
    },
  )
  ipcMain.handle(
    IPC_CHANNELS.APP_IMPORT_DATA,
    async (_e, zipPath: string, fingerprint?: string) => {
      const { importAllData } = await import('../store/backup-restore.js')
      return importAllData(zipPath, fingerprint)
    },
  )

  // 数据迁移：从加密的 .sabackup 文件导入（输入密码解密后导入）
  ipcMain.handle(
    IPC_CHANNELS.APP_IMPORT_DATA_DECRYPTED,
    async (_e, filePath: string, password: string, fingerprint?: string) => {
      const { importAllDataDecrypted } = await import('../store/backup-restore.js')
      return importAllDataDecrypted(filePath, password, fingerprint)
    },
  )

  // 选文件后立即检测是否 SABK 加密（不进入导入流程）
  ipcMain.handle(IPC_CHANNELS.APP_DETECT_BACKUP_ENCRYPTED, async (_e, filePath: string) => {
    const { isSabkEncrypted } = await import('../platform/security/file-crypto.js')
    try {
      return isSabkEncrypted(filePath)
    } catch {
      return false
    }
  })

  // 数据迁移：估算各类别导出体积（字节）
  ipcMain.handle(IPC_CHANNELS.APP_ESTIMATE_EXPORT_SIZES, async () => {
    const { estimateExportSizes } = await import('../store/backup-restore.js')
    return estimateExportSizes()
  })

  // 数据迁移：打开数据导出独立窗口（单例）
  ipcMain.handle(IPC_CHANNELS.APP_OPEN_EXPORT_WINDOW, async () => {
    const { showDataExportWindow } = await import('../platform/window/containers/popup-windows.js')
    showDataExportWindow()
  })

  // 缓存清理：清理缓存数据（仅缓存类目录与 session cache，保留登录态）
  ipcMain.handle(IPC_CHANNELS.APP_CLEAN_CACHE, async () => {
    const { cleanCacheData } = await import('../store/cache-maintenance.js')
    // 休眠快照的保留策略来自设置，此处一并传入，使保留策略与设置页显示一致
    const _current = getAppSettings()
    const result = await cleanCacheData({
      retentionDays: 7,
      maxCount: 40,
    })
    // 更新上次清理时间戳
    updateAppSettings({ lastCacheCleanAt: Date.now() })
    return result
  })

  // 缓存清理：估算当前缓存体积
  ipcMain.handle(IPC_CHANNELS.APP_ESTIMATE_CACHE_SIZE, async () => {
    const { estimateCacheSize } = await import('../store/cache-maintenance.js')
    return estimateCacheSize()
  })

  // 下载：选择下载目录（弹出系统目录选择对话框）
  ipcMain.handle(IPC_CHANNELS.APP_SELECT_DOWNLOAD_DIR, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // 下载：在系统文件管理器中打开下载目录（无配置时打开系统下载目录）
  ipcMain.handle(IPC_CHANNELS.APP_OPEN_DOWNLOAD_DIR, async () => {
    const settings = getAppSettings()
    const dir = settings.downloadDir || app.getPath('downloads')
    try {
      await shell.openPath(dir)
    } catch (err) {
      console.error('[app-settings] 打开下载目录失败:', err)
    }
  })

  ipcMain.handle(IPC_CHANNELS.APP_OPEN_LOGS_FOLDER, async (_event, options?: LogExportOptions) => {
    const { getChatStore } = await import('../store/chat-store.js')
    return openActivityLogFolder(
      app.getPath('userData'),
      () => getChatStore().activityLogRecords(),
      (directory) => shell.openPath(directory),
      options,
      applicationLogSources(),
    )
  })

  ipcMain.handle(IPC_CHANNELS.LOCAL_FILE_DROP_PREPARE, async (event) =>
    (await import('../browser/file-drop-handler.js')).prepareFileDrop(event),
  )
  ipcMain.handle(IPC_CHANNELS.LOCAL_FILE_DROP_CAPTURE, async (event, input: unknown) =>
    (await import('../browser/file-drop-handler.js')).captureFileDrop(event, input),
  )
  ipcMain.handle(IPC_CHANNELS.WEBVIEW_FILE_DROP, async (event, input: unknown) =>
    (await import('../browser/file-drop-handler.js')).readDroppedFiles(event, input),
  )
  ipcMain.handle(IPC_CHANNELS.LOCAL_FILE_DROP_OPEN, async (event, input: unknown) =>
    (await import('../browser/file-drop-handler.js')).openDroppedFiles(event, input),
  )

  // ===== 每应用浏览器窗口脱离/回归快捷键 =====
  // 保存/清除指定 Profile 的浏览器窗口快捷键，并重注册全局快捷键
  ipcMain.handle(
    IPC_CHANNELS.PROFILE_SHORTCUT_SET,
    async (_e, { profileId, accelerator }: { profileId: string; accelerator: string | null }) => {
      const { profileStore } = await import('../browser/profile-store.js')
      const updated = await profileStore.update(profileId, {
        browserWindowShortcut: accelerator || undefined,
      })
      await reregisterProfileShortcuts()
      return updated
    },
  )
}
