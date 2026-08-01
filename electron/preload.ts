// electron/preload.ts — 主 UI 窗口的 Preload 脚本
//
// 通过 contextBridge 暴露类型安全的 API 到渲染进程（window.electron）。
// contextIsolation 始终开启，不直接暴露 ipcRenderer，仅暴露最小必要接口。

import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type AIPlatform, type Profile, type PromptTemplate, type ElectronAPI } from './shared/types.js'
import { AI_PLATFORMS } from './presets/ai-platforms.js'

const api: ElectronAPI = {
  // Profile 管理
  profile: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.PROFILE_LIST),
    create: (partial) => ipcRenderer.invoke(IPC_CHANNELS.PROFILE_CREATE, partial),
    update: (id, patch) => ipcRenderer.invoke(IPC_CHANNELS.PROFILE_UPDATE, id, patch),
    delete: (id) => ipcRenderer.invoke(IPC_CHANNELS.PROFILE_DELETE, id),
    duplicate: (id) => ipcRenderer.invoke(IPC_CHANNELS.PROFILE_DUPLICATE, id),
    reorder: (orderedIds) => ipcRenderer.invoke(IPC_CHANNELS.PROFILE_REORDER, orderedIds),
    /** 监听 Profile 被任意窗口更新后的广播（跨窗口同步） */
    onUpdated: (callback) => {
      const handler = (_e: unknown, data: { id: string; profile: Profile }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.PROFILE_UPDATED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PROFILE_UPDATED, handler);
    },
    /** 监听 Profile 新建/复制后的广播（跨窗口同步新增卡片） */
    onCreated: (callback) => {
      const handler = (_e: unknown, profile: Profile) => callback(profile);
      ipcRenderer.on(IPC_CHANNELS.PROFILE_CREATED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PROFILE_CREATED, handler);
    },
    /** 监听 Profile 删除后的广播（跨窗口同步移除卡片） */
    onDeleted: (callback) => {
      const handler = (_e: unknown, profileId: string) => callback(profileId);
      ipcRenderer.on(IPC_CHANNELS.PROFILE_DELETED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PROFILE_DELETED, handler);
    },
    /** 监听 Profile 拖拽排序后的广播（跨窗口同步顺序） */
    onReordered: (callback) => {
      const handler = (_e: unknown, orderedIds: string[]) => callback(orderedIds);
      ipcRenderer.on(IPC_CHANNELS.PROFILE_REORDERED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PROFILE_REORDERED, handler);
    },
  },
  // 窗口管理
  window: {
    open: (profileId) => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_OPEN, profileId),
    close: (profileId) => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CLOSE, profileId),
    closeAll: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CLOSE_ALL),
    switchUA: (profileId, ua) =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_SWITCH_UA, profileId, ua),
    switchDevice: (profileId, presetId) =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_SWITCH_DEVICE, profileId, presetId),
    setAlwaysOnTop: (profileId, onTop) =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_SET_ALWAYS_ON_TOP, profileId, onTop),
    getOpenWindowIds: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_GET_OPEN_IDS),
    setupSession: (profileId) =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_SETUP_SESSION, profileId),
  },
  // 窗口控制（操作调用方所在窗口本身）
  windowControl: {
    minimize: () => ipcRenderer.invoke(IPC_CHANNELS.WIN_CONTROL_MINIMIZE),
    maximizeToggle: () =>
      ipcRenderer.invoke(IPC_CHANNELS.WIN_CONTROL_MAXIMIZE_TOGGLE),
    close: () => ipcRenderer.invoke(IPC_CHANNELS.WIN_CONTROL_CLOSE),
    setAlwaysOnTop: (onTop) =>
      ipcRenderer.invoke(IPC_CHANNELS.WIN_CONTROL_SET_ALWAYS_ON_TOP, onTop),
    isMaximized: () => ipcRenderer.invoke(IPC_CHANNELS.WIN_CONTROL_IS_MAXIMIZED),
    isAlwaysOnTop: () => ipcRenderer.invoke(IPC_CHANNELS.WIN_CONTROL_IS_ALWAYS_ON_TOP),
    getBounds: () => ipcRenderer.invoke(IPC_CHANNELS.WIN_CONTROL_GET_BOUNDS),
    detachTab: (tabId) =>
      ipcRenderer.invoke(IPC_CHANNELS.WIN_CONTROL_DETACH_TAB, tabId),
    resize: (bounds) =>
      ipcRenderer.invoke(IPC_CHANNELS.WIN_CONTROL_RESIZE, bounds),
    toggleFullscreen: () =>
      ipcRenderer.invoke(IPC_CHANNELS.WIN_CONTROL_TOGGLE_FULLSCREEN),
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
    get: (windowId) => ipcRenderer.invoke(IPC_CHANNELS.WIN_STATE_GET, windowId),
    save: (windowId, state) =>
      ipcRenderer.invoke(IPC_CHANNELS.WIN_STATE_SAVE, windowId, state),
    listDetachedWindowIds: () =>
      ipcRenderer.invoke(IPC_CHANNELS.WIN_STATE_LIST_DETACHED),
    remove: (windowId) => ipcRenderer.invoke(IPC_CHANNELS.WIN_STATE_REMOVE, windowId),
  },
  // 标签管理
  tab: {
    updateTitle: (windowId, tabId, title) =>
      ipcRenderer.invoke(IPC_CHANNELS.TAB_UPDATE_TITLE, windowId, tabId, title),
    updateUrl: (windowId, tabId, url) =>
      ipcRenderer.invoke(IPC_CHANNELS.TAB_UPDATE_URL, windowId, tabId, url),
    updateHomeUrl: (windowId, tabId, homeUrl) =>
      ipcRenderer.invoke(IPC_CHANNELS.TAB_UPDATE_HOME_URL, windowId, tabId, homeUrl),
  },
  // 设备预设
  presets: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.PRESETS_LIST),
    get: (id) => ipcRenderer.invoke(IPC_CHANNELS.PRESETS_GET, id),
    save: (preset) => ipcRenderer.invoke(IPC_CHANNELS.PRESETS_SAVE, preset),
    delete: (id) => ipcRenderer.invoke(IPC_CHANNELS.PRESETS_DELETE, id),
    update: (id, patch) => ipcRenderer.invoke(IPC_CHANNELS.PRESETS_UPDATE, id, patch),
  },
  // 语音识别
  stt: {
    // 测试 AI 接入配置连通性（设置页"测试连接"按钮调用）
    testAi: (input: { providerId: string }) => {
      return ipcRenderer.invoke(IPC_CHANNELS.VOICE_TEST_AI, input)
    },
    // 强制停止当前录音（preview 客户端兜底用：主进程 keyup 丢失时由 preview 主动调）
    forceStop: (reason: string) => ipcRenderer.invoke(IPC_CHANNELS.VOICE_FORCE_STOP, reason),
    // 麦克风设备列表
    updateInputDeviceList: (list: unknown[]) =>
      ipcRenderer.invoke(IPC_CHANNELS.VOICE_INPUT_DEVICES_UPDATE, list),
    refreshInputDevices: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_INPUT_DEVICES_REFRESH),
    // 检查 whisper-cli 二进制是否实际存在（不依赖 cfg.downloadStatus）
    checkCliExists: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_CHECK_CLI_EXISTS),
    // 检查单个 whisper 模型文件是否实际存在
    checkModelExists: (modelId: string) => ipcRenderer.invoke(IPC_CHANNELS.VOICE_CHECK_MODEL_EXISTS, modelId),
    // 列出磁盘上所有已下载的 whisper 模型 id
    listDownloadedModels: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_LIST_DOWNLOADED_MODELS),
  },
  // 热键
  hotkey: {
    register: (accelerator, callback) => {
      const handler = (_e: unknown, acc: string) => {
        if (acc === accelerator) callback()
      }
      ipcRenderer.on(IPC_CHANNELS.HOTKEY_TRIGGERED, handler)
      return ipcRenderer.invoke(IPC_CHANNELS.HOTKEY_REGISTER, accelerator)
    },
    unregister: (accelerator) =>
      ipcRenderer.invoke(IPC_CHANNELS.HOTKEY_UNREGISTER, accelerator),
    isRegistered: (accelerator) =>
      ipcRenderer.invoke(IPC_CHANNELS.HOTKEY_IS_REGISTERED, accelerator),
    getAll: () => ipcRenderer.invoke(IPC_CHANNELS.HOTKEY_GET_ALL),
    set: (action, accelerator) =>
      ipcRenderer.invoke(IPC_CHANNELS.HOTKEY_SET, action, accelerator),
    setEnabled: (action, enabled) =>
      ipcRenderer.invoke(IPC_CHANNELS.HOTKEY_SET_ENABLED, action, enabled),
    startRecording: () => ipcRenderer.invoke(IPC_CHANNELS.HOTKEY_START_RECORDING),
    stopRecording: () => ipcRenderer.invoke(IPC_CHANNELS.HOTKEY_STOP_RECORDING),
    onRecordingResult: (callback: (result: { accelerator: string; reason?: string }) => void) => {
      const handler = (_e: unknown, result: { accelerator: string; reason?: string }) => callback(result)
      ipcRenderer.on(IPC_CHANNELS.HOTKEY_START_RECORDING, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.HOTKEY_START_RECORDING, handler)
    },
    /**
     * 订阅热键录制实时反馈（主进程 → 渲染层：每次按键时推送当前修饰键+按键组合）
     * 用于录制 UI 实时显示用户按下的组合，无需等到最终键按下。
     * @returns 取消监听函数
     */
    onRecordingPartial: (callback: (partial: { modifiers: string[]; key: string | null }) => void) => {
      const handler = (_e: unknown, partial: { modifiers: string[]; key: string | null }) => callback(partial)
      ipcRenderer.on(IPC_CHANNELS.HOTKEY_RECORDING_PARTIAL, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.HOTKEY_RECORDING_PARTIAL, handler)
    },
    /**
     * 订阅热键管理器状态变化（主进程推送）
     * @param callback 状态：{ uiohookStarted, voiceHotkeyRegistered, voiceKeyPressed, pollingActive }
     */
    onStatus: (callback) => {
      const handler = (_e: unknown, status: unknown) => callback(status)
      ipcRenderer.on(IPC_CHANNELS.HOTKEY_STATUS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.HOTKEY_STATUS, handler)
    },
  },
  // AI 平台
  aiPlatform: {
    // 同步获取预置平台列表（无 Profile 合并），用于立即渲染兜底
    presetList: (): AIPlatform[] => AI_PLATFORMS,
    // 异步获取完整列表（合并 Profile 自定义覆盖），静默更新
    list: () => ipcRenderer.invoke(IPC_CHANNELS.AI_PLATFORM_LIST),
  },
  // 提示词模板（明输入明注入）
  prompt: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.PROMPT_LIST),
    save: (template) => ipcRenderer.invoke(IPC_CHANNELS.PROMPT_SAVE, template),
    delete: (id) => ipcRenderer.invoke(IPC_CHANNELS.PROMPT_DELETE, id),
    exportPrompts: () => ipcRenderer.invoke(IPC_CHANNELS.PROMPT_EXPORT),
    importPrompts: () => ipcRenderer.invoke(IPC_CHANNELS.PROMPT_IMPORT),
    openWindow: () => ipcRenderer.invoke(IPC_CHANNELS.PROMPT_OPEN_WINDOW),
    // 需求 1：传递完整 PromptTemplate，由主窗口渲染层在 webview 上下文中组合后注入
    requestInject: (template) => ipcRenderer.invoke(IPC_CHANNELS.PROMPT_INJECT_REQUEST, template),
  },
  // 注入历史管理（需求 2：注入预览 + Jaccard 去重）
  injection: {
    log: (record) => ipcRenderer.invoke(IPC_CHANNELS.INJECTION_LOG, record),
    findSimilar: (text, limit, threshold) =>
      ipcRenderer.invoke(IPC_CHANNELS.INJECTION_FIND_SIMILAR, text, limit, threshold),
  },
  // 指纹脚本（单页架构：渲染进程取脚本注入 webview）
  fingerprint: {
    getScript: (profileId) =>
      ipcRenderer.invoke(IPC_CHANNELS.FINGERPRINT_GET_SCRIPT, profileId),
  },
  // 语音输入配置（enterToSend 等全局设置）
  voice: {
    getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_GET_CONFIG),
    setConfig: (patch) => ipcRenderer.invoke(IPC_CHANNELS.VOICE_SET_CONFIG, patch),
    // 底栏语音按钮触发：走后台语音路径，显示独立预览窗
    triggerStart: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_TRIGGER_START),
    triggerStop: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_TRIGGER_STOP),
    // 下载 whisper 模型 / 引擎二进制
    downloadModel: (modelId: string) => ipcRenderer.invoke(IPC_CHANNELS.VOICE_DOWNLOAD_MODEL, modelId),
    downloadWhisperCli: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_DOWNLOAD_WHISPER_CLI),
    // 卸载 whisper-cli 引擎二进制（删除 userData/bin/ 下所有引擎相关文件 + 修正 cfg）
    uninstallWhisperCli: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_UNINSTALL_WHISPER_CLI),
    // 卸载指定 whisper 模型文件（删除对应 ggml-*.bin + 从 cfg.downloadedModels 移除）
    uninstallModel: (modelId: 'whisper-tiny' | 'whisper-base' | 'whisper-small') =>
      ipcRenderer.invoke(IPC_CHANNELS.VOICE_UNINSTALL_MODEL, modelId),
    // v0.5.2 regress-2：测试 TTS 配置连通性（发送短文本合成请求，返回 audio dataURL）
    testTts: (input: { providerId: string }) => {
      return ipcRenderer.invoke(IPC_CHANNELS.VOICE_TEST_TTS, input)
    },
    onDownloadProgress: (cb: (p: { type: 'model' | 'cli'; percent: number; status: string; detail?: string }) => void) => {
      const handler = (_e: unknown, p: unknown) => cb(p as Parameters<typeof cb>[0])
      ipcRenderer.on(IPC_CHANNELS.VOICE_DOWNLOAD_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_DOWNLOAD_PROGRESS, handler)
    },
  },
  // 应用全局设置（区域代理、隐藏国外模型等）
  appSettings: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_SETTINGS),
    update: (patch) => ipcRenderer.invoke(IPC_CHANNELS.APP_UPDATE_SETTINGS, patch),
    testProxy: () => ipcRenderer.invoke(IPC_CHANNELS.APP_TEST_PROXY),
    applyProxy: () => ipcRenderer.invoke(IPC_CHANNELS.APP_APPLY_PROXY),
    applyProxyFallback: () => ipcRenderer.invoke(IPC_CHANNELS.APP_PROXY_FALLBACK),
    clearAllData: () => ipcRenderer.invoke(IPC_CHANNELS.APP_CLEAR_ALL_DATA),
    selectExportPath: () => ipcRenderer.invoke(IPC_CHANNELS.APP_SELECT_EXPORT_PATH),
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
    ) => ipcRenderer.invoke(IPC_CHANNELS.APP_EXPORT_DATA, targetPath, options),
    importData: (zipPath: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_IMPORT_DATA, zipPath),
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
  // 引导 API（首次启动引导窗 + 重新查看入口）
  onboarding: {
    show: () => ipcRenderer.invoke(IPC_CHANNELS.ONBOARDING_SHOW),
    isCompleted: () => ipcRenderer.invoke(IPC_CHANNELS.ONBOARDING_IS_COMPLETED),
    complete: (patch) => ipcRenderer.invoke(IPC_CHANNELS.ONBOARDING_COMPLETE, patch),
  },
  // 灵感笔记 API（v2：SQLite + FTS5 + 富文本 + 分类）
  notes: {
    list: (filter?: { keyword?: string; tag?: string; pinnedOnly?: boolean }) =>
      ipcRenderer.invoke(IPC_CHANNELS.NOTES_LIST, filter),
    search: (keyword: string) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_SEARCH, keyword),
    save: (input) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_SAVE, input),
    saveSync: (input) => ipcRenderer.sendSync(IPC_CHANNELS.NOTES_SAVE_SYNC, input),
    delete: (id) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_DELETE, id),
    getActive: () => ipcRenderer.invoke(IPC_CHANNELS.NOTES_GET_ACTIVE),
    setActive: (id) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_SET_ACTIVE, id),
    setPinned: (id, pinned) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_SET_PINNED, id, pinned),
    setTags: (id, tags) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_SET_TAGS, id, tags),
    listTags: () => ipcRenderer.invoke(IPC_CHANNELS.NOTES_LIST_TAGS),
    sendToAi: (text, enterToSend) =>
      ipcRenderer.invoke(IPC_CHANNELS.NOTES_SEND_TO_AI, { text, enterToSend }),
    saveAsPrompt: (content, title) =>
      ipcRenderer.invoke(IPC_CHANNELS.NOTES_SAVE_AS_PROMPT, { content, title }),
    saveImage: (dataUrl: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.NOTES_SAVE_IMAGE, dataUrl),
    onInjectResult: (callback: (result: { success: boolean; error?: string }) => void) => {
      const handler = (_e: unknown, result: { success: boolean; error?: string }) => callback(result)
      ipcRenderer.on(IPC_CHANNELS.NOTES_INJECT_RESULT, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.NOTES_INJECT_RESULT, handler)
    },
  },
  // 白板 API（v3：Excalidraw + 多白板）
  whiteboard: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.WHITEBOARD_LIST),
    create: (title?: string) => ipcRenderer.invoke(IPC_CHANNELS.WHITEBOARD_CREATE, title),
    rename: (id, title) => ipcRenderer.invoke(IPC_CHANNELS.WHITEBOARD_RENAME, id, title),
    delete: (id) => ipcRenderer.invoke(IPC_CHANNELS.WHITEBOARD_DELETE, id),
    getActive: () => ipcRenderer.invoke(IPC_CHANNELS.WHITEBOARD_GET_ACTIVE),
    setActive: (id) => ipcRenderer.invoke(IPC_CHANNELS.WHITEBOARD_SET_ACTIVE, id),
    getSnapshot: (id) => ipcRenderer.invoke(IPC_CHANNELS.WHITEBOARD_GET_SNAPSHOT, id),
    saveSnapshot: (id, snapshot) => ipcRenderer.invoke(IPC_CHANNELS.WHITEBOARD_SAVE_SNAPSHOT, id, snapshot),
    // 同步保存（beforeunload 兜底）
    saveSnapshotSync: (id, snapshot) => ipcRenderer.sendSync(IPC_CHANNELS.WHITEBOARD_SAVE_SNAPSHOT_SYNC, id, snapshot),
  },
  // 平台能力查询（设置页显示权限状态）
  platformCapabilities: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.PLATFORM_CAPABILITIES),
  },
  // 页面组件屏蔽规则
  blockRules: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.BLOCK_RULES_LIST),
    save: (rule) => ipcRenderer.invoke(IPC_CHANNELS.BLOCK_RULES_SAVE, rule),
    delete: (id) => ipcRenderer.invoke(IPC_CHANNELS.BLOCK_RULES_DELETE, id),
    update: (id, patch) => ipcRenderer.invoke(IPC_CHANNELS.BLOCK_RULES_UPDATE, id, patch),
  },
  /** 打开 AI 应用编辑窗口（多例；编辑模式按 profileId 单例，新建模式固定 'create' 单例） */
  openAiAppEditor: (opts: {
    platformId?: string;
    profileId?: string;
    mode?: 'edit' | 'create';
  }) => {
    return ipcRenderer.invoke(IPC_CHANNELS.AI_APP_EDITOR_OPEN, opts)
  },
  /** 打开设置独立窗口（单例） */
  openSettingsWindow: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_WINDOW_OPEN)
  },
  /** 打开 进阶面板（单例，承载内置 AI/自定义供应商/自定义对话） */
  openAdvancedPanelWindow: (providerId?: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.ADVANCED_PANEL_OPEN, providerId)
  },
  /** 切换 进阶面板显隐（单例） */
  toggleAdvancedPanelWindow: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.ADVANCED_PANEL_TOGGLE)
  },
  /** 主→渲染：单例窗口复用时通知切换 tab/provider */
  onAdvancedPanelNavigate: (
    callback: (payload: { tab: 'chat' | 'whiteboard' | 'notes'; providerId?: string }) => void,
  ) => {
    const handler = (_e: unknown, payload: { tab: 'chat' | 'whiteboard' | 'notes'; providerId?: string }) =>
      callback(payload)
    ipcRenderer.on(IPC_CHANNELS.ADVANCED_PANEL_NAVIGATE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.ADVANCED_PANEL_NAVIGATE, handler)
  },
  /** 主→渲染：UI 比例变化广播（设置面板修改 uiScale 后通知各窗口重新计算最小尺寸） */
  onUiScaleChanged: (callback: (uiScale: 'small' | 'medium' | 'large') => void) => {
    const handler = (_e: unknown, uiScale: 'small' | 'medium' | 'large') => callback(uiScale)
    ipcRenderer.on(IPC_CHANNELS.UI_SCALE_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.UI_SCALE_CHANGED, handler)
  },
  // 自定义 AI 提供商
  aiProvider: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_LIST),
    create: (input) => ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_CREATE, input),
    update: (id, patch) =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_UPDATE, id, patch),
    delete: (id) => ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_DELETE, id),
    test: (input) => ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_TEST, input),
    listModels: (input) => ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_LIST_MODELS, input),
    exportEncrypted: (password, selectedIds?) => ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_EXPORT_ENCRYPTED, password, selectedIds),
    importEncrypted: (encrypted, password) =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_IMPORT_ENCRYPTED, encrypted, password),
    // v0.5.2 B-4：预览导入（dry-run）
    previewImport: (encrypted: string, password: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_PREVIEW_IMPORT, encrypted, password),
    // v0.5.2 B-4：选择导出文件保存路径（.sapp 文件）
    selectExportPath: () => ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_SELECT_EXPORT_PATH),
    // v0.5.2 B-4：选择导入文件
    selectImportFile: () => ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_SELECT_IMPORT_FILE),
    // v0.5.2 B-4：写入加密导出文件
    writeExportFile: (filePath: string, content: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_WRITE_EXPORT_FILE, filePath, content),
    // v0.5.2 B-4：读取导入文件
    readImportFile: (filePath: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_READ_IMPORT_FILE, filePath),
  },
  // 对话持久化（SQLite）
  chat: {
    listConversations: (sourceId) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_LIST_CONVERSATIONS, sourceId),
    createConversation: (sourceId, sourceType, title, url) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.CHAT_CREATE_CONVERSATION,
        sourceId,
        sourceType,
        title,
        url,
      ),
    getLastConversationUrl: (sourceId) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_GET_LAST_CONV_URL, sourceId),
    deleteConversation: (id) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_DELETE_CONVERSATION, id),
    listMessages: (conversationId) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_LIST_MESSAGES, conversationId),
    saveMessageWithMerge: (msg) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_SAVE_MESSAGE_WITH_MERGE, msg),
    // webview 抓取入库后通知主进程广播给其他窗口（HistoryView 订阅刷新侧边栏）
    notifyConversationPersisted: (sourceId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_NOTIFY_PERSISTED, sourceId),
    // 订阅入库广播事件（主进程 → 所有窗口）
    onConversationPersisted: (callback: (payload: { sourceId: string }) => void) => {
      const handler = (_e: unknown, payload: { sourceId: string }) => callback(payload)
      ipcRenderer.on(IPC_CHANNELS.CHAT_CONVERSATION_PERSISTED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_CONVERSATION_PERSISTED, handler)
    },
    search: (query) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_SEARCH, query),
    send: (payload) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_SEND, payload),
    cancel: (conversationId) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_CANCEL, conversationId),
    onStreamChunk: (callback) => {
      const handler = (
        _e: unknown,
        chunk: import('./shared/types.js').ChatStreamChunk,
      ) => callback(chunk)
      ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_CHUNK, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_CHUNK, handler)
    },
    onStreamEnd: (callback) => {
      const handler = (
        _e: unknown,
        info: { conversationId: string; ok: boolean; error?: string },
      ) => callback(info)
      ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_END, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_END, handler)
    },
    logLoginTrace: (trace) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_LOG_LOGIN_TRACE, trace),
    listWindowTraces: (windowId, limit) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_LIST_WINDOW_TRACES, windowId, limit),
    listLoginTraces: (profileId) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_LIST_LOGIN_TRACES, profileId),
    getUsageStats: (sourceId) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_GET_USAGE_STATS, sourceId),
    exportConversation: (conversationId, format) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_EXPORT_CONVERSATION, conversationId, format),
    importConversation: (format, sourceId) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_IMPORT_CONVERSATION, format, sourceId),
    clearConversations: (sourceId) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_CLEAR_CONVERSATIONS, sourceId),
    clearLoginTraces: (profileId) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_CLEAR_LOGIN_TRACES, profileId),
    clearWindowTraces: (windowId) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_CLEAR_WINDOW_TRACES, windowId),
    // 使用统计与操作日志
    clearUsageTraces: () =>
      ipcRenderer.invoke(IPC_CHANNELS.USAGE_TRACE_CLEAR),
    updateMessage: (messageId, updates) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_UPDATE_MESSAGE, messageId, updates),
    deleteMessage: (messageId) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_DELETE_MESSAGE, messageId),
    updateConversation: (id, updates) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_UPDATE_CONVERSATION, id, updates),
    openHistoryWindow: () => ipcRenderer.invoke(IPC_CHANNELS.CHAT_OPEN_HISTORY_WINDOW),
    updateDetachedWindow: (windowId, config) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_UPDATE_DETACHED, windowId, config),
    getChatConfig: (windowId) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_GET_CONFIG, windowId),
    // Alt+Q 无对话窗口时，主进程请求打开配置
    onRequestConfig: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on(IPC_CHANNELS.CHAT_REQUEST_CONFIG, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_REQUEST_CONFIG, handler)
    },
  },
  // 新标签页（主进程拦截 webview 弹窗后 → 渲染层）
  onNewTab: (callback: (url: string, windowId: string) => void) => {
    const handler = (_e: unknown, url: string, windowId: string) => callback(url, windowId)
    ipcRenderer.on(IPC_CHANNELS.RENDERER_NEW_TAB, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.RENDERER_NEW_TAB, handler)
  },
  // 主→渲染：webview 弹窗 URL 转发（主进程拦截 window.open / target="_blank" 后，
  // 将 URL + guest webContents id 发回渲染层，由渲染层在匹配的当前 webview 内导航）
  onWebviewPopupUrl: (
    callback: (payload: { url: string; webContentsId: number }) => void,
  ) => {
    const handler = (
      _e: unknown,
      payload: { url: string; webContentsId: number },
    ) => callback(payload)
    ipcRenderer.on(IPC_CHANNELS.WEBVIEW_POPUP_URL, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.WEBVIEW_POPUP_URL, handler)
  },
  /** 主→渲染：弹窗被连续拒绝达阈值（默认3次），提示用户加白名单 */
  onPopupDenied: (
    callback: (payload: { url: string; origin: string; count: number }) => void,
  ) => {
    const handler = (
      _e: unknown,
      payload: { url: string; origin: string; count: number },
    ) => callback(payload)
    ipcRenderer.on(IPC_CHANNELS.WEBVIEW_POPUP_DENIED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.WEBVIEW_POPUP_DENIED, handler)
  },
  /** 渲染→主：将 origin 加入弹窗白名单（持久化到 AppSettings.popupWhitelist） */
  addToPopupWhitelist: (origin: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.POPUP_WHITELIST_ADD, origin),
  /** 渲染→主：将 origin 加入指定 Profile 的专属白名单（持久化到 Profile.popupWhitelist） */
  addToProfilePopupWhitelist: (profileId: string, origin: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.POPUP_WHITELIST_ADD_PROFILE, { profileId, origin }),
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
  // 后台语音注入+发送（主→最近聚焦窗口渲染：背景路径识别完成后注入 AI 输入框）
  // 载荷：{ text, enterToSend }，由渲染层决定是否自动回车发送
  onVoiceInjectAndSend: (
    callback: (payload: { text: string; enterToSend: boolean }) => void,
  ) => {
    const handler = (
      _e: unknown,
      payload: { text: string; enterToSend: boolean },
    ) => callback(payload)
    ipcRenderer.on(IPC_CHANNELS.VOICE_INJECT_AND_SEND, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_INJECT_AND_SEND, handler)
  },
  // 预览窗更新（主→预览窗渲染）
  onPreviewUpdate: (
    callback: (payload: {
      text: string
      status: 'recording' | 'transcribing' | 'done' | 'sent'
    }) => void,
  ) => {
    const handler = (
      _e: unknown,
      payload: { text: string; status: 'recording' | 'transcribing' | 'done' | 'sent' },
    ) => callback(payload)
    ipcRenderer.on(IPC_CHANNELS.PREVIEW_UPDATE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PREVIEW_UPDATE, handler)
  },
  // 预览窗隐藏（主→预览窗渲染）
  onPreviewHide: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC_CHANNELS.PREVIEW_HIDE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PREVIEW_HIDE, handler)
  },
  // 渲染进程音频采集：开始录音（主→预览窗渲染）
  onVoiceRecordStart: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC_CHANNELS.VOICE_RECORD_START, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_RECORD_START, handler)
  },
  // 渲染进程音频采集：停止录音（主→预览窗渲染）
  onVoiceRecordStop: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC_CHANNELS.VOICE_RECORD_STOP, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_RECORD_STOP, handler)
  },
  // 渲染进程音频采集：回传 PCM 数据（预览窗渲染→主）
  sendVoiceRecordData: (data: number[]) => {
    ipcRenderer.send(IPC_CHANNELS.VOICE_RECORD_DATA, data)
  },
  // builtin 模式 Web Speech API：主→渲染（通知渲染层启动 webkitSpeechRecognition）
  // 载荷：{ language: string } —— BCP-47 语种标签（如 'zh-CN'），渲染层据此设置 recognition.lang
  onVoiceBuiltinStart: (callback: (payload: { language: string }) => void) => {
    const handler = (_e: unknown, payload: { language: string }) => callback(payload)
    ipcRenderer.on(IPC_CHANNELS.VOICE_BUILTIN_START, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_BUILTIN_START, handler)
  },
  // builtin 模式识别结果回传（预览窗渲染→主：携带识别到的文本）
  sendVoiceBuiltinResult: (text: string) => {
    ipcRenderer.send(IPC_CHANNELS.VOICE_BUILTIN_RESULT, text)
  },
  // builtin 模式识别错误回传（预览窗渲染→主：携带错误信息）
  sendVoiceBuiltinError: (error: string) => {
    ipcRenderer.send(IPC_CHANNELS.VOICE_BUILTIN_ERROR, error)
  },
  // 提示词注入请求（主→主窗口渲染：提示词库窗口请求注入激活 webview）
  // 需求 1：传递完整 PromptTemplate，由主窗口渲染层在 webview 上下文中组合后注入
  onPromptInjectRequest: (callback: (template: PromptTemplate) => void) => {
    const handler = (_e: unknown, template: PromptTemplate) => callback(template)
    ipcRenderer.on(IPC_CHANNELS.PROMPT_INJECT_REQUEST, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PROMPT_INJECT_REQUEST, handler)
  },
  // 提示词注入结果（主→提示词库窗口渲染：注入成功/失败回传）
  onPromptInjectResult: (
    callback: (result: { success: boolean; platformName?: string }) => void,
  ) => {
    const handler = (
      _e: unknown,
      result: { success: boolean; platformName?: string },
    ) => callback(result)
    ipcRenderer.on(IPC_CHANNELS.PROMPT_INJECT_RESULT, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PROMPT_INJECT_RESULT, handler)
  },
  // 主窗口渲染 → 主进程：回传注入结果（主进程再转发到提示词库窗口）
  sendPromptInjectResult: (result: { success: boolean; platformName?: string }) => {
    ipcRenderer.send(IPC_CHANNELS.PROMPT_INJECT_RESULT, result)
  },
  // 主→渲染：webview 内应用快捷键转发（主进程 before-input-event 拦截后通知渲染层执行）
  onWebviewHotkey: (
    callback: (payload: {
      action: 'switchTab' | 'cycleTab' | 'toggleSpatialNav' | 'openShortcuts' | 'toggleTheme' | 'navBack' | 'navForward' | 'navRefresh' | 'newTab' | 'closeTab'
      data?: unknown
    }) => void,
  ) => {
    const handler = (_e: unknown, payload: unknown) => callback(payload as Parameters<typeof callback>[0])
    ipcRenderer.on(IPC_CHANNELS.WEBVIEW_HOTKEY, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.WEBVIEW_HOTKEY, handler)
  },
}

// 暴露到 window.electron
contextBridge.exposeInMainWorld('electron', api)

// 在 <html> 标记平台，供 CSS 按平台调整拖拽区域（macOS 避让交通灯等）。
// contextIsolation 下 preload 与渲染层共享 DOM，可直接写 document 属性。
document.documentElement.setAttribute('data-platform', process.platform)

// 监听窗口最大化/全屏状态，设置 html data 属性以控制窗口级圆角。
// 普通窗口保持圆角；最大化/全屏时移除圆角，避免黑边。
function updateWindowShapeAttributes() {
  ipcRenderer.invoke(IPC_CHANNELS.WIN_CONTROL_IS_MAXIMIZED).then((isMax: boolean) => {
    document.documentElement.setAttribute('data-maximized', String(isMax))
  }).catch(() => { /* ignore */ })
}
ipcRenderer.on(IPC_CHANNELS.WIN_CONTROL_MAXIMIZE_TOGGLED, (_e, isMax: boolean) => {
  document.documentElement.setAttribute('data-maximized', String(isMax))
})
ipcRenderer.on(IPC_CHANNELS.WIN_CONTROL_FULLSCREEN_TOGGLED, (_e, isFs: boolean) => {
  document.documentElement.setAttribute('data-fullscreen', String(isFs))
})
updateWindowShapeAttributes()

// ===== 使用统计：全局 data-name 点击日志监听器 =====
// 监听主进程下发的窗口类型（main/chat/advanced-panel/history/prompt-library/...），
// 写入 window.__ai_window_type__ 供点击日志的 windowType 字段使用。
let windowType: string | null = null
;(window as unknown as { __ai_window_type__?: string | null }).__ai_window_type__ = null
ipcRenderer.on(IPC_CHANNELS.SET_WINDOW_TYPE, (_e, type: string | null) => {
  windowType = type
  ;(window as unknown as { __ai_window_type__?: string | null }).__ai_window_type__ = type
})

// 全局捕获带 data-name 元素的点击事件，debounce 100ms，写入 SQLite click_logs。
// 仅记录有 data-name 属性的元素（按钮/菜单/热键触发点），不记录无 data-name 的普通点击。
;(() => {
  let lastClickName = ''
  let lastClickTs = 0
  document.addEventListener(
    'click',
    (e: Event) => {
      try {
        const target = e.target as HTMLElement | null
        if (!target || !target.closest) return
        const el = target.closest('[data-name]') as HTMLElement | null
        if (!el) return
        const name = el.dataset.name
        if (!name) return
        const now = Date.now()
        // 同一元素 100ms 内的重复点击丢弃（防抖）
        if (name === lastClickName && now - lastClickTs < 100) return
        lastClickName = name
        lastClickTs = now
        ipcRenderer.invoke(IPC_CHANNELS.USAGE_TRACE_LOG_CLICK, name, windowType).catch(() => { /* ignore */ })
      } catch {
        // 点击日志失败不影响正常交互
      }
    },
    true, // capture: 在事件冒泡前捕获
  )
})()
