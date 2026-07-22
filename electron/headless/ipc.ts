// electron/headless/ipc.ts — 无头浏览器 IPC 注册
//
// 将 HeadlessBrowserManager 的能力通过 ipcMain.handle 暴露给渲染进程。
// 在 app.whenReady 后调用 registerHeadlessIPC() 完成注册。

import { ipcMain, app } from 'electron'
import { IPC_CHANNELS } from '../shared/types.js'
import { headlessBrowser } from './browser-manager.js'

/** 注册无头浏览器相关 IPC handler */
export function registerHeadlessIPC(): void {
  const ipc = IPC_CHANNELS

  ipcMain.handle(ipc.HEADLESS_IS_RUNNING, () => headlessBrowser.isRunning())

  ipcMain.handle(ipc.HEADLESS_VERSION, () => headlessBrowser.version())

  ipcMain.handle(ipc.HEADLESS_CLOSE, async () => {
    await headlessBrowser.close()
    return true
  })

  ipcMain.handle(ipc.HEADLESS_CREATE_PAGE, (_e, url?: string) =>
    headlessBrowser.createPage(url),
  )

  ipcMain.handle(ipc.HEADLESS_CLOSE_PAGE, (_e, pageId: string) =>
    headlessBrowser.closePage(pageId),
  )

  ipcMain.handle(ipc.HEADLESS_LIST_PAGES, () => headlessBrowser.listPages())

  ipcMain.handle(ipc.HEADLESS_GET_PAGE_INFO, (_e, pageId: string) =>
    headlessBrowser.getPageInfo(pageId),
  )

  ipcMain.handle(ipc.HEADLESS_NAVIGATE, (_e, pageId: string, url: string) =>
    headlessBrowser.navigate(pageId, url),
  )

  ipcMain.handle(
    ipc.HEADLESS_SCREENSHOT,
    (
      _e,
      pageId: string,
      options?: { fullPage?: boolean; saveToFile?: string },
    ) => headlessBrowser.screenshot(pageId, options),
  )

  ipcMain.handle(ipc.HEADLESS_PDF, (_e, pageId: string) =>
    headlessBrowser.pdf(pageId),
  )

  ipcMain.handle(ipc.HEADLESS_EVALUATE, (_e, pageId: string, script: string) =>
    headlessBrowser.evaluate(pageId, script),
  )

  // 应用退出前清理
  app.on('before-quit', async () => {
    if (headlessBrowser.isRunning()) {
      await headlessBrowser.close()
    }
  })
}
