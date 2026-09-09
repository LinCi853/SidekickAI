import { ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/types.js'

export const windowApi = {
  // 窗口管理
  window: {
    open: (profileId: string) => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_OPEN, profileId),
    close: (profileId: string) => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CLOSE, profileId),
    closeAll: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CLOSE_ALL),
    switchUA: (profileId: string, ua: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_SWITCH_UA, profileId, ua),
    switchDevice: (profileId: string, presetId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_SWITCH_DEVICE, profileId, presetId),
    setAlwaysOnTop: (profileId: string, onTop: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_SET_ALWAYS_ON_TOP, profileId, onTop),
    getOpenWindowIds: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_GET_OPEN_IDS),
    setupSession: (profileId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_SETUP_SESSION, profileId),
  },
  // 窗口控制（操作调用方所在窗口本身）
  windowControl: {
    minimize: () => ipcRenderer.invoke(IPC_CHANNELS.WIN_CONTROL_MINIMIZE),
    maximizeToggle: () =>
      ipcRenderer.invoke(IPC_CHANNELS.WIN_CONTROL_MAXIMIZE_TOGGLE),
    close: () => ipcRenderer.invoke(IPC_CHANNELS.WIN_CONTROL_CLOSE),
    setAlwaysOnTop: (onTop: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.WIN_CONTROL_SET_ALWAYS_ON_TOP, onTop),
    isMaximized: () => ipcRenderer.invoke(IPC_CHANNELS.WIN_CONTROL_IS_MAXIMIZED),
    isAlwaysOnTop: () => ipcRenderer.invoke(IPC_CHANNELS.WIN_CONTROL_IS_ALWAYS_ON_TOP),
    getBounds: () => ipcRenderer.invoke(IPC_CHANNELS.WIN_CONTROL_GET_BOUNDS),
    detachTab: (tabId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.WIN_CONTROL_DETACH_TAB, tabId),
    resize: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke(IPC_CHANNELS.WIN_CONTROL_RESIZE, bounds),
    toggleFullscreen: () =>
      ipcRenderer.invoke(IPC_CHANNELS.WIN_CONTROL_TOGGLE_FULLSCREEN),
    exitFullscreen: () =>
      ipcRenderer.invoke(IPC_CHANNELS.WIN_CONTROL_EXIT_FULLSCREEN),
    // 云游戏备用方案：把系统光标重置到指定屏幕坐标（指针锁定不可用时的光标居中）
    setCursor: (x: number, y: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.CURSOR_SET, x, y),
    // 动态设置当前窗口的最小尺寸（UI 比例变化时重新约束）
    setMinimumSize: (width: number, height: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.WIN_CONTROL_SET_MIN_SIZE, width, height),
    // 获取当前窗口的最小尺寸（resize 拖拽时动态获取真实下限）
    getMinimumSize: () =>
      ipcRenderer.invoke(IPC_CHANNELS.WIN_CONTROL_GET_MIN_SIZE),
    // 主→渲染：webview 快捷键主进程兜底触发后，同步状态
    onMaximizeToggled: (callback: (isMaximized: boolean) => void) => {
      const handler = (_e: unknown, isMax: boolean) => callback(isMax)
      ipcRenderer.on(IPC_CHANNELS.WIN_CONTROL_MAXIMIZE_TOGGLED, handler)
      return () =>
        ipcRenderer.removeListener(
          IPC_CHANNELS.WIN_CONTROL_MAXIMIZE_TOGGLED,
          handler,
        )
    },
    onFullscreenToggled: (callback: (isFullscreen: boolean) => void) => {
      const handler = (_e: unknown, isFs: boolean) => callback(isFs)
      ipcRenderer.on(IPC_CHANNELS.WIN_CONTROL_FULLSCREEN_TOGGLED, handler)
      return () =>
        ipcRenderer.removeListener(
          IPC_CHANNELS.WIN_CONTROL_FULLSCREEN_TOGGLED,
          handler,
        )
    },
    onPinToggled: (callback: (alwaysOnTop: boolean) => void) => {
      const handler = (_e: unknown, onTop: boolean) => callback(onTop)
      ipcRenderer.on(IPC_CHANNELS.WIN_CONTROL_PIN_TOGGLED, handler)
      return () =>
        ipcRenderer.removeListener(
          IPC_CHANNELS.WIN_CONTROL_PIN_TOGGLED,
          handler,
        )
    },
  },
  // 窗口状态持久化
  windowState: {
    get: (windowId: string) => ipcRenderer.invoke(IPC_CHANNELS.WIN_STATE_GET, windowId),
    save: (windowId: string, state: unknown) =>
      ipcRenderer.invoke(IPC_CHANNELS.WIN_STATE_SAVE, windowId, state),
    listDetachedWindowIds: () =>
      ipcRenderer.invoke(IPC_CHANNELS.WIN_STATE_LIST_DETACHED),
    remove: (windowId: string) => ipcRenderer.invoke(IPC_CHANNELS.WIN_STATE_REMOVE, windowId),
  },
  // 标签管理
  tab: {
    updateTitle: (windowId: string, tabId: string, title: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.TAB_UPDATE_TITLE, windowId, tabId, title),
    updateUrl: (windowId: string, tabId: string, url: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.TAB_UPDATE_URL, windowId, tabId, url),
    updateHomeUrl: (windowId: string, tabId: string, homeUrl: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.TAB_UPDATE_HOME_URL, windowId, tabId, homeUrl),
    // 主→渲染：窗口快捷键兜底请求（主窗口无该 Profile 标签时，要求渲染层创建并返回 tabId）
    onEnsureAndDetach: (callback: (profileId: string) => void) => {
      const handler = (_e: unknown, profileId: string) => callback(profileId)
      ipcRenderer.on(IPC_CHANNELS.TAB_ENSURE_AND_DETACH, handler)
      return () =>
        ipcRenderer.removeListener(IPC_CHANNELS.TAB_ENSURE_AND_DETACH, handler)
    },
    // 渲染→主：回复兜底请求结果（tabId 或 null）
    reportEnsureAndDetachResult: (payload: { profileId: string; tabId: string | null }) =>
      ipcRenderer.send(IPC_CHANNELS.TAB_ENSURE_AND_DETACH_RESULT, payload),
  },
  // 窗口重新显示/聚焦到前台（主→渲染：每次 show/focus 通知渲染层聚焦输入框）
  onWindowShown: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC_CHANNELS.WINDOW_SHOWN, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.WINDOW_SHOWN, handler)
  },
  onWindowHidden: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC_CHANNELS.WINDOW_HIDDEN, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.WINDOW_HIDDEN, handler)
  },
  /** 主→渲染：UI 比例变化广播（设置面板修改 uiScale 后通知各窗口重新计算最小尺寸） */
  onUiScaleChanged: (callback: (uiScale: 'small' | 'medium' | 'large') => void) => {
    const handler = (_e: unknown, uiScale: 'small' | 'medium' | 'large') => callback(uiScale)
    ipcRenderer.on(IPC_CHANNELS.UI_SCALE_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.UI_SCALE_CHANGED, handler)
  },
  /** 主→渲染：弹窗被连续拦截 N 次后提示用户加白 */
  onPopupDenied: (callback: (data: { origin: string; count: number }) => void) => {
    const handler = (_e: unknown, data: { origin: string; count: number }) => callback(data)
    ipcRenderer.on(IPC_CHANNELS.POPUP_DENIED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.POPUP_DENIED, handler)
  },
  /** 渲染→主：添加 origin 到全局弹窗白名单 */
  addToPopupWhitelist: (origin: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.POPUP_ADD_WHITELIST, origin),
  /** 渲染→主：添加 origin 到 Profile 专属弹窗白名单 */
  addToProfilePopupWhitelist: (profileId: string, origin: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.POPUP_ADD_PROFILE_WHITELIST, profileId, origin),
}
