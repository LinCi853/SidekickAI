import { ipcRenderer } from 'electron'
import { IPC_CHANNELS, type AppSettings } from '../shared/types.js'

export const appSettingsApi = {
  // 应用全局设置（区域代理、隐藏国外模型等）
  appSettings: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_SETTINGS),
    update: (patch: unknown) => ipcRenderer.invoke(IPC_CHANNELS.APP_UPDATE_SETTINGS, patch),
    testProxy: () => ipcRenderer.invoke(IPC_CHANNELS.APP_TEST_PROXY),
    applyProxy: () => ipcRenderer.invoke(IPC_CHANNELS.APP_APPLY_PROXY),
    applyProxyFallback: () => ipcRenderer.invoke(IPC_CHANNELS.APP_PROXY_FALLBACK),
    testProfileProxy: (profileId: string) => ipcRenderer.invoke(IPC_CHANNELS.APP_TEST_PROFILE_PROXY, profileId),
    applyProfileProxy: (profileId: string) => ipcRenderer.invoke(IPC_CHANNELS.APP_APPLY_PROFILE_PROXY, profileId),
    applyProfileProxyFallback: (profileId: string) => ipcRenderer.invoke(IPC_CHANNELS.APP_PROFILE_PROXY_FALLBACK, profileId),
    // 每应用浏览器窗口脱离/回归快捷键（保存 accelerator 或传 null 清除）
    setProfileShortcut: (profileId: string, accelerator: string | null) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROFILE_SHORTCUT_SET, { profileId, accelerator }),
    clearAllData: () => ipcRenderer.invoke(IPC_CHANNELS.APP_CLEAR_ALL_DATA),
    selectExportPath: (encrypted?: boolean) => ipcRenderer.invoke(IPC_CHANNELS.APP_SELECT_EXPORT_PATH, encrypted),
    selectImportFile: () => ipcRenderer.invoke(IPC_CHANNELS.APP_SELECT_IMPORT_FILE),
    exportData: (
      targetPath: string,
      options: {
        basicData: boolean;
        cookies: boolean;
        indexedDB: boolean;
        cache: boolean;
        voiceAssets: boolean;
      },
      encrypt?: { password: string },
    ) => ipcRenderer.invoke(IPC_CHANNELS.APP_EXPORT_DATA, targetPath, options, encrypt),
    importData: (filePath: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_IMPORT_DATA, filePath),
    importDataDecrypted: (filePath: string, password: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_IMPORT_DATA_DECRYPTED, filePath, password),
    estimateExportSizes: () => ipcRenderer.invoke(IPC_CHANNELS.APP_ESTIMATE_EXPORT_SIZES),
    openExportWindow: () => ipcRenderer.invoke(IPC_CHANNELS.APP_OPEN_EXPORT_WINDOW),
    // 缓存清理：清理缓存数据（仅缓存类目录与 session cache，保留登录态）
    cleanCache: () => ipcRenderer.invoke(IPC_CHANNELS.APP_CLEAN_CACHE),
    // 缓存清理：估算当前缓存体积（字节）
    estimateCacheSize: () => ipcRenderer.invoke(IPC_CHANNELS.APP_ESTIMATE_CACHE_SIZE),
    // 下载：选择下载目录（弹出系统目录选择对话框）
    selectDownloadDir: () => ipcRenderer.invoke(IPC_CHANNELS.APP_SELECT_DOWNLOAD_DIR),
    // 下载：在系统文件管理器中打开下载目录
    openDownloadDir: () => ipcRenderer.invoke(IPC_CHANNELS.APP_OPEN_DOWNLOAD_DIR),
    // 文件拖拽导入：读取文件并以 data URL 形式返回（用于跨 webview 边界传递文件内容）
    dropFiles: (filePaths: string[]) =>
      ipcRenderer.invoke(IPC_CHANNELS.WEBVIEW_FILE_DROP, filePaths),
    // 主→渲染：下载完成通知（filename + path）
    onDownloadDone: (callback: (info: { filename: string; path: string }) => void) => {
      const handler = (_e: unknown, info: { filename: string; path: string }) => callback(info)
      ipcRenderer.on(IPC_CHANNELS.APP_DOWNLOAD_DONE, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_DOWNLOAD_DONE, handler)
    },
  },
  // 平台能力查询（设置页显示权限状态）
  platformCapabilities: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.PLATFORM_CAPABILITIES),
  },
  // 引导 API（首次启动引导窗 + 重新查看入口）
  onboarding: {
    show: () => ipcRenderer.invoke(IPC_CHANNELS.ONBOARDING_SHOW),
    isCompleted: () => ipcRenderer.invoke(IPC_CHANNELS.ONBOARDING_IS_COMPLETED),
    complete: (patch: unknown) => ipcRenderer.invoke(IPC_CHANNELS.ONBOARDING_COMPLETE, patch),
  },
  // 页面组件屏蔽规则
  blockRules: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.BLOCK_RULES_LIST),
    save: (rule: unknown) => ipcRenderer.invoke(IPC_CHANNELS.BLOCK_RULES_SAVE, rule),
    delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.BLOCK_RULES_DELETE, id),
    update: (id: string, patch: unknown) => ipcRenderer.invoke(IPC_CHANNELS.BLOCK_RULES_UPDATE, id, patch),
  },
  /** 主→渲染：应用设置变更广播（任意窗口修改设置后通知所有窗口同步） */
  onAppSettingsChanged: (callback: (settings: AppSettings) => void) => {
    const handler = (_e: unknown, settings: AppSettings) => callback(settings)
    ipcRenderer.on(IPC_CHANNELS.APP_SETTINGS_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_SETTINGS_CHANGED, handler)
  },
  /** 渲染→主：请求广播 UI 版本/主题变更到所有窗口（Oxy 切换 / 主题模式切换时调用） */
  broadcastUiVersionChanged: (payload: { uiVersion: 'classic' | 'oxy'; theme: 'light' | 'dark' | 'system' }) => {
    ipcRenderer.send(IPC_CHANNELS.APP_UI_VERSION_CHANGED, payload)
  },
  /** 主→渲染：UI 版本/主题变更广播（任意窗口切换 Oxy 或主题后通知所有窗口同步） */
  onUiVersionChanged: (callback: (payload: { uiVersion: 'classic' | 'oxy'; theme: 'light' | 'dark' | 'system' }) => void) => {
    const handler = (_e: unknown, payload: { uiVersion: 'classic' | 'oxy'; theme: 'light' | 'dark' | 'system' }) => callback(payload)
    ipcRenderer.on(IPC_CHANNELS.APP_UI_VERSION_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_UI_VERSION_CHANGED, handler)
  },
  /** 渲染→主：请求广播 Oxy 主题色变更到所有窗口（切换 AI 应用时调用） */
  broadcastThemeColorChanged: (hex: string) => {
    ipcRenderer.send(IPC_CHANNELS.APP_THEME_COLOR_CHANGED, hex)
  },
  /** 主→渲染：Oxy 主题色变更广播（主窗口切换 AI 应用后通知所有窗口同步主题色） */
  onThemeColorChanged: (callback: (hex: string) => void) => {
    const handler = (_e: unknown, hex: string) => callback(hex)
    ipcRenderer.on(IPC_CHANNELS.APP_THEME_COLOR_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_THEME_COLOR_CHANGED, handler)
  },
}
