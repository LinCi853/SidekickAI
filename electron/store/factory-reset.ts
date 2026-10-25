// electron/store/factory-reset.ts — 恢复出厂设置编排（清除所有用户数据并重启）
//
// 从 app-settings-store 拆出的独立编排：只被设置 IPC 动态调用。
// 删除 userData / 便携 data 目录下的全部持久化文件（含设置、对话、窗口位置、登录记录等），然后重启应用。
//
// 完整清理流程（按顺序，每步独立 try/catch 避免单点失败阻塞）：
//   1. 设置 isQuitting 标记 —— 绕过主窗口 closeBehavior='minimize' 的 close 事件拦截
//   2. 中止活跃 AI 流 —— 释放 fetch 连接，避免阻塞
//   3. 关闭 SQLite 连接 —— 释放 chat.db / chat.db-wal / chat.db-shm 文件锁
//   4. 清理所有 session —— defaultSession + persist:<profileId> partitions
//      （cookies/localStorage/IndexedDB/cache/auth 全部清空，删除登录痕迹）
//   5. 销毁所有 BrowserWindow —— 使用 destroy() 而非 close()，绕过 close 事件
//      并等待 closed 事件 + 超时兜底，确保 webContents 文件句柄释放
//   6. 递归删除数据目录 —— 失败时逐个删除关键子项，处理 Windows 文件锁
//   7. 重启应用 —— app.relaunch + app.exit(0)
//
// 注意：app.exit(0) 会跳过 before-quit 钩子，因此 main.ts 中的 hotkeyManager /
// sttEngine / tray 等私有资源的清理逻辑不会执行。这些 native 句柄由 OS 在进程
// 退出时自动回收，不影响数据文件清理的可靠性。

import { app, BrowserWindow, session } from 'electron'
import path from 'path'
import fs from 'fs'
import { getStoreCwd } from './store-paths.js'
import { resetSettingsCacheForTest } from './app-settings-repository.js'
import { abortAllAssetStreams } from '../assets/asset-stream-activity.js'

export async function clearAllData(): Promise<void> {
  const dataDir = getStoreCwd() ?? app.getPath('userData')

  console.log('[app-settings] 开始清理所有用户数据:', dataDir)
  console.log('[app-settings] 重置内存缓存 settingsCache=null')
  resetSettingsCacheForTest()

  // 1. 设置 isQuitting 标记，绕过主窗口 closeBehavior='minimize' 拦截
  try {
    ;(app as unknown as { isQuitting?: boolean }).isQuitting = true
  } catch {
    /* ignore */
  }

  // 2. 中止活跃 AI 流式请求（避免 fetch 阻塞进程退出）
  try {
    abortAllAssetStreams()
  } catch (err) {
    console.warn('[app-settings] 中止 AI 流失败:', err)
  }

  // 3. 关闭所有 SQLite 连接（释放 WAL 旁路文件锁，避免 fs.rmSync 失败）
  // 模块声明的 closeDb 钩子（插件数据库）
  try {
    const { closeAllModuleDbs } = await import('../modules/registry.js')
    await closeAllModuleDbs()
  } catch {
    /* ignore */
  }
  const sqliteClosures = [
    () =>
      import('../assets/collection-journal.js')
        .then((m) => m.closeAssetCollectionJournal())
        .catch(() => {}),
    () => import('./chat-store.js').then((m) => m.closeChatStore()).catch(() => {}),
    () => import('./module-state-store.js').then((m) => m.closeModuleStateDb()).catch(() => {}),
    () =>
      import('../modules/plugins/notes/notes-db.js').then((m) => m.closeNotesDb()).catch(() => {}),
    () =>
      import('../modules/plugins/whiteboard/whiteboard-db.js')
        .then((m) => m.closeWhiteboardDb())
        .catch(() => {}),
    () =>
      import('../browser/nav-history-store.js')
        .then((m) => m.closeNavHistoryStore())
        .catch(() => {}),
    () =>
      import('../browser/bookmark-store.js').then((m) => m.closeBookmarkStore()).catch(() => {}),
    () =>
      import('../browser/search-history-store.js')
        .then((m) => m.closeSearchHistoryStore())
        .catch(() => {}),
    () =>
      import('../browser/browser-download-store.js')
        .then((m) => m.closeBrowserDownloadStore())
        .catch(() => {}),
    () =>
      import('./accumulated-links-store.js')
        .then((m) => m.accumulatedLinksStore.close())
        .catch(() => {}),
  ]
  for (const close of sqliteClosures) {
    try {
      await close()
    } catch {
      /* ignore */
    }
  }

  // 4. 收集并清理所有 session（defaultSession + persist:<profileId> partitions）
  //    每个会话独立清理 cookies/localStorage/IndexedDB/cache/auth，删除登录痕迹
  const sessionsToClean: Electron.Session[] = [session.defaultSession]
  try {
    const { profileStore } = await import('../browser/profile-store.js')
    for (const profile of profileStore.list()) {
      try {
        sessionsToClean.push(session.fromPartition(`persist:${profile.id}`))
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    console.warn('[app-settings] 收集 partition sessions 失败:', err)
  }

  await Promise.all(
    sessionsToClean.map(async (s) => {
      try {
        await s.clearStorageData()
      } catch {
        /* ignore */
      }
      try {
        await s.clearCache()
      } catch {
        /* ignore */
      }
      try {
        await s.clearAuthCache()
      } catch {
        /* ignore */
      }
    }),
  )

  // 5. 销毁所有 BrowserWindow（destroy 而非 close，绕过 close 事件拦截）
  //    等待 closed 事件确保 webContents 文件句柄释放，带 1s 超时兜底
  await new Promise<void>((resolve) => {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    if (wins.length === 0) return resolve()
    let remaining = wins.length
    let settled = false
    const done = () => {
      if (settled) return
      remaining -= 1
      if (remaining <= 0) {
        settled = true
        resolve()
      }
    }
    for (const win of wins) {
      if (win.isDestroyed()) {
        done()
        continue
      }
      win.once('closed', done)
      try {
        win.destroy()
      } catch {
        done()
      }
    }
    // 超时兜底：1s 后强制继续（destroy 是同步的，但 OS 释放句柄可能需要时间）
    setTimeout(() => {
      if (!settled) {
        settled = true
        resolve()
      }
    }, 1000)
  })

  // 给文件系统一点时间释放底层句柄（Windows 上 destroy 后 LevelDB/IndexedDB
  // 句柄释放是异步的，立即 rmSync 可能 EBUSY）
  // 增加到 500ms 以确保 Windows 上 SQLite WAL/SHM 文件锁完全释放
  await new Promise((resolve) => setTimeout(resolve, 500))

  // 6. 递归删除数据目录（设置、窗口状态、AI供应商、对话历史等全部持久化数据）
  // 先直接尝试删除 settings.db（最关键：阻止重启后读到旧 onboardingCompleted）
  const settingsDbPath = path.join(dataDir, 'settings.db')
  const settingsDbWal = path.join(dataDir, 'settings.db-wal')
  const settingsDbShm = path.join(dataDir, 'settings.db-shm')

  // 带重试的文件删除函数（Windows 上文件锁释放可能需要多次尝试）。
  // 退避等待用 setTimeout 而非忙等：忙等会烧 CPU 并加剧恢复出厂期间的 UI 冻结
  const unlinkWithRetry = async (
    filePath: string,
    maxRetries = 3,
    delayMs = 200,
  ): Promise<boolean> => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath)
          console.log(`[app-settings] 已删除关键文件 (attempt ${attempt}):`, filePath)
          return true
        }
        return true // 文件不存在也算成功
      } catch (err) {
        console.warn(
          `[app-settings] 删除文件失败 (attempt ${attempt}/${maxRetries}):`,
          filePath,
          err,
        )
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, delayMs))
        }
      }
    }
    return false
  }

  // 优先删除 settings.db 及其 WAL/SHM 文件
  for (const f of [settingsDbPath, settingsDbWal, settingsDbShm]) {
    await unlinkWithRetry(f)
  }

  try {
    fs.rmSync(dataDir, { recursive: true, force: true })
    console.log('[app-settings] 已清除所有用户数据:', dataDir)
  } catch (err) {
    console.error('[app-settings] 递归删除失败，尝试逐个删除关键子项:', err)
    // Windows 上 GPUCache/Crashpad/SingletonLock/Partitions 等可能因句柄未完全释放而失败
    // 逐个尝试删除关键子目录和文件，最大程度清理
    const subPaths = [
      // Electron / Chromium 缓存与临时文件
      'GPUCache',
      'Crashpad',
      'DawnGraphiteCache',
      'DawnWebGPUCache',
      'Session Storage',
      'Local Storage',
      'IndexedDB',
      'databases',
      'Service Worker',
      'Cache',
      'Code Cache',
      'Cookies',
      'Cookies-journal',
      'Network',
      'SharedStorage',
      'Shared Dictionary',
      'WebStorage',
      'Preferences',
      'Local State',
      'Partitions',
      'bin',
      'SingletonLock',
      'SingletonCookie',
      'SingletonSocket',
      // settings.db（单一数据源，含 app_settings / profiles / window_states 等 KV 表）
      'settings.db',
      'settings.db-wal',
      'settings.db-shm',
      // 各模块独立 SQLite 数据库
      'chat.db',
      'chat.db-wal',
      'chat.db-shm',
      'notes.db',
      'notes.db-wal',
      'notes.db-shm',
      'whiteboard.db',
      'whiteboard.db-wal',
      'whiteboard.db-shm',
      'nav-history.db',
      'nav-history.db-wal',
      'nav-history.db-shm',
      'bookmarks.db',
      'bookmarks.db-wal',
      'bookmarks.db-shm',
      'search-history.db',
      'search-history.db-wal',
      'search-history.db-shm',
      'browser-downloads.db',
      'browser-downloads.db-wal',
      'browser-downloads.db-shm',
      'accumulated-links.db',
      'accumulated-links.db-wal',
      'accumulated-links.db-shm',
      // 资产目录（图片等）
      'whiteboard-assets',
      'notes-assets',
    ]
    // 追加插件声明的数据库文件和资产目录
    try {
      const { collectModuleDataFiles } = await import('../modules/registry.js')
      const pluginFiles = collectModuleDataFiles()
      for (const db of pluginFiles.dbFiles) {
        subPaths.push(db, db + '-wal', db + '-shm')
      }
      subPaths.push(...pluginFiles.assetDirs)
    } catch {
      /* ignore */
    }
    for (const sub of subPaths) {
      try {
        fs.rmSync(path.join(dataDir, sub), { recursive: true, force: true })
        console.log('[app-settings] 逐个删除:', sub)
      } catch {
        /* ignore */
      }
    }
    // 再次尝试删除整个目录
    try {
      fs.rmSync(dataDir, { recursive: true, force: true })
      console.log('[app-settings] 二次删除成功:', dataDir)
    } catch (err2) {
      console.error(
        '[app-settings] 二次删除仍失败（部分文件可能被锁定，重启后由新进程清理）:',
        err2,
      )
    }
  }

  // 7. 最终验证：确保 settings.db 已被删除（最关键）
  //    如果 settings.db 仍然存在，重启后会读到旧的 onboardingCompleted=true，导致引导不显示
  if (fs.existsSync(settingsDbPath)) {
    console.error('[app-settings] 警告：settings.db 仍然存在，尝试最后强制删除')
    // 再等待 300ms 后重试
    await new Promise((resolve) => setTimeout(resolve, 300))
    try {
      fs.unlinkSync(settingsDbPath)
      console.log('[app-settings] 最终强制删除成功')
    } catch (finalErr) {
      console.error('[app-settings] 最终删除仍失败，重启后将依赖新进程清理:', finalErr)
    }
  }

  // 8. 重启应用
  app.relaunch()
  app.exit(0)
}
