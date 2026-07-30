// electron/window/tray.ts — 系统托盘创建与管理
//
// 从 main.ts 抽离：
//   - createTray：创建托盘图标 + 右键菜单（显示主窗口 / 窗口复位 / 退出）
//   - 单击托盘切换主窗口显隐
//
// tray 实例为本模块私有状态。main.ts 通过 hasTray() 判断 window-all-closed 是否退出，
// 通过 destroyTray() 在 before-quit 销毁托盘。trayEnabled 同步到 windowState 供其他模块读取。

import { app, Menu, Tray, nativeImage, screen } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import { IPC_CHANNELS } from '../shared/types.js'
import { windowState } from '../window-state.js'
import { createMainWindow } from '../window-factory.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 系统托盘实例（本模块私有）
let tray: Tray | null = null

/**
 * 创建系统托盘
 * 功能：显示主窗口、窗口复位（大小位置）、退出应用
 */
export function createTray(): void {
  if (tray) return
  try {
    const resourcesPath = path.join(__dirname, '..', '..', 'resources', 'icons')
    const isMac = process.platform === 'darwin'
    // macOS 使用 template image（单色，自动适配深色/浅色模式）；
    // Windows/Linux 使用彩色 icon.png（16x16）
    const iconPath = isMac
      ? path.join(resourcesPath, 'icon-tray-template.png')
      : path.join(resourcesPath, 'icon.png')
    let trayIcon = nativeImage.createFromPath(iconPath)
    // macOS template image 缺失时回退到 icon.png，避免托盘创建失败
    if (isMac && trayIcon.isEmpty()) {
      console.warn('[main] macOS template 托盘图标缺失，回退 icon.png')
      trayIcon = nativeImage.createFromPath(path.join(resourcesPath, 'icon.png'))
    }
    if (trayIcon.isEmpty()) {
      console.warn('[main] 托盘图标不存在，跳过创建托盘')
      return
    }
    if (isMac) {
      // template image 自动适配深色/浅色模式；macOS 托盘规范 22x22
      trayIcon.setTemplateImage(true)
      trayIcon = trayIcon.resize({ width: 22, height: 22 })
    } else {
      trayIcon = trayIcon.resize({ width: 16, height: 16 })
    }
    tray = new Tray(trayIcon)
    tray.setToolTip('工百窗')
    windowState.trayEnabled = true

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => {
          const win = windowState.mainWindow
          if (!win || win.isDestroyed()) {
            createMainWindow()
            return
          }
          if (win.isMinimized()) win.restore()
          if (!win.isVisible()) win.show()
          win.focus()
          win.webContents.send(IPC_CHANNELS.WINDOW_SHOWN)
        },
      },
      {
        label: '窗口复位（恢复默认大小位置）',
        click: () => {
          const win = windowState.mainWindow
          if (!win || win.isDestroyed()) return
          const workArea = screen.getPrimaryDisplay().workArea
          const defaultWidth = 420
          const defaultHeight = 820
          const x = Math.round(workArea.x + workArea.width - defaultWidth - 20)
          const y = Math.round(workArea.y + 20)
          if (win.isMaximized()) win.unmaximize()
          if (win.isMinimized()) win.restore()
          if (!win.isVisible()) win.show()
          win.setBounds({ x, y, width: defaultWidth, height: defaultHeight })
          win.focus()
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          app.quit()
        },
      },
    ])

    tray.setContextMenu(contextMenu)

    // 单击显示/隐藏主窗口
    tray.on('click', () => {
      const win = windowState.mainWindow
      if (!win || win.isDestroyed()) {
        createMainWindow()
        return
      }
      if (win.isVisible()) {
        win.hide()
      } else {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
        win.webContents.send(IPC_CHANNELS.WINDOW_SHOWN)
      }
    })

    console.log('[main] 系统托盘已创建')
  } catch (err) {
    console.error('[main] 创建托盘失败:', err)
  }
}

/** 判断托盘是否已创建（main.ts window-all-closed 用此决定是否退出） */
export function hasTray(): boolean {
  return tray !== null
}

/** 销毁托盘（main.ts before-quit 调用，避免进程残留） */
export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
    windowState.trayEnabled = false
  }
}
