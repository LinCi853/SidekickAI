// ipc-channels.ts — IPC 通道名常量
// 由 shared/types.ts 拆分而来；常量定义内容保持原样，仅做物理拆分。

// ============================================================================
// IPC 通道名常量
// ============================================================================

export const IPC_CHANNELS = {
  // Profile
  PROFILE_LIST: 'profile:list',
  PROFILE_CREATE: 'profile:create',
  PROFILE_UPDATE: 'profile:update',
  PROFILE_DELETE: 'profile:delete',
  PROFILE_DUPLICATE: 'profile:duplicate',
  PROFILE_REORDER: 'profile:reorder',
  // 主→渲染：Profile 被任意窗口更新后广播（跨窗口同步名称等字段）
  PROFILE_UPDATED: 'profile:updated',
  // 主→渲染：Profile 新建/复制后广播（跨窗口同步新增卡片）
  PROFILE_CREATED: 'profile:created',
  // 主→渲染：Profile 删除后广播（跨窗口同步移除卡片、关闭相关 tab）
  PROFILE_DELETED: 'profile:deleted',
  // 主→渲染：Profile 拖拽排序后广播（跨窗口同步顺序）
  PROFILE_REORDERED: 'profile:reordered',
  // Window
  WINDOW_OPEN: 'window:open',
  WINDOW_CLOSE: 'window:close',
  WINDOW_CLOSE_ALL: 'window:closeAll',
  WINDOW_SWITCH_UA: 'window:switchUA',
  WINDOW_SWITCH_DEVICE: 'window:switchDevice',
  WINDOW_SET_ALWAYS_ON_TOP: 'window:setAlwaysOnTop',
  WINDOW_GET_OPEN_IDS: 'window:getOpenIds',
  WINDOW_SETUP_SESSION: 'window:setupSession', // 单页架构：为 webview 准备 session
  // 窗口控制（操作调用方所在窗口本身）
  WIN_CONTROL_MINIMIZE: 'winControl:minimize',
  WIN_CONTROL_MAXIMIZE_TOGGLE: 'winControl:maximizeToggle',
  WIN_CONTROL_CLOSE: 'winControl:close',
  WIN_CONTROL_SET_ALWAYS_ON_TOP: 'winControl:setAlwaysOnTop',
  WIN_CONTROL_IS_MAXIMIZED: 'winControl:isMaximized',
  WIN_CONTROL_IS_ALWAYS_ON_TOP: 'winControl:isAlwaysOnTop',
  WIN_CONTROL_GET_BOUNDS: 'winControl:getBounds',
  WIN_CONTROL_DETACH_TAB: 'winControl:detachTab',
  WIN_CONTROL_RESIZE: 'winControl:resize',
  WIN_CONTROL_SET_MIN_SIZE: 'winControl:setMinSize',
  WIN_CONTROL_GET_MIN_SIZE: 'winControl:getMinSize',
  WIN_CONTROL_TOGGLE_FULLSCREEN: 'winControl:toggleFullscreen',
  WIN_CONTROL_EXIT_FULLSCREEN: 'winControl:exitFullscreen',
  // 主→渲染：webview 快捷键主进程兜底触发后，同步状态到渲染层（按钮图标等）
  WIN_CONTROL_MAXIMIZE_TOGGLED: 'winControl:maximizeToggled',
  WIN_CONTROL_FULLSCREEN_TOGGLED: 'winControl:fullscreenToggled',
  WIN_CONTROL_PIN_TOGGLED: 'winControl:pinToggled',
  // 窗口状态持久化
  WIN_STATE_GET: 'winState:get',
  WIN_STATE_SAVE: 'winState:save',
  WIN_STATE_LIST_DETACHED: 'winState:listDetached',
  WIN_STATE_REMOVE: 'winState:remove',
  // 标签管理
  TAB_UPDATE_TITLE: 'tab:updateTitle',
  TAB_UPDATE_URL: 'tab:updateUrl',
  TAB_UPDATE_HOME_URL: 'tab:updateHomeUrl',
  // 窗口快捷键兜底：主窗口无该 Profile 标签时，主进程请求主窗口渲染层创建标签并脱离
  // 主→渲染：请求（profileId），渲染→主：回复（{ profileId, tabId } | null）
  TAB_ENSURE_AND_DETACH: 'tab:ensureAndDetach',
  TAB_ENSURE_AND_DETACH_RESULT: 'tab:ensureAndDetach:result',
  // Fingerprint
  FINGERPRINT_GET_SCRIPT: 'fingerprint:getScript', // 获取指纹注入脚本
  // Presets
  PRESETS_LIST: 'presets:list',
  PRESETS_GET: 'presets:get',
  PRESETS_SAVE: 'presets:save',
  PRESETS_DELETE: 'presets:delete',
  PRESETS_UPDATE: 'presets:update',
  // STT
  STT_START: 'stt:start',
  STT_STOP: 'stt:stop',
  STT_RESULT: 'stt:result',
  STT_ERROR: 'stt:error',
  // Hotkey
  HOTKEY_REGISTER: 'hotkey:register',
  HOTKEY_UNREGISTER: 'hotkey:unregister',
  HOTKEY_IS_REGISTERED: 'hotkey:isRegistered',
  HOTKEY_TRIGGERED: 'hotkey:triggered',
  HOTKEY_GET_ALL: 'hotkey:getAll', // 获取全部内置热键配置
  HOTKEY_SET: 'hotkey:set', // 设置某个内置热键（action, accelerator）
  HOTKEY_SET_ENABLED: 'hotkey:setEnabled', // 启用/禁用某个内置热键（action, enabled）
  HOTKEY_STATUS: 'hotkey:status', // 主进程推送热键管理器状态（启动后 / 状态变化时）
  HOTKEY_START_RECORDING: 'hotkey:startRecording', // 开始录制热键（主进程临时注册 globalShortcut 捕获按键）
  HOTKEY_STOP_RECORDING: 'hotkey:stopRecording', // 停止录制热键
  HOTKEY_RECORDING_PARTIAL: 'hotkey:recordingPartial', // 录制实时反馈（主进程 → 渲染层：每次按键时推送当前组合）
  // 窗口重新展示（主进程 → 渲染层：脱离窗口被 Alt+Q 显示时通知刷新 webview）
  WINDOW_SHOWN: 'window:shown',
  WINDOW_HIDDEN: 'window:hidden',
  // 新标签页（主进程 → 渲染层：拦截 webview 弹窗后通知渲染层新建标签）
  RENDERER_NEW_TAB: 'renderer:newTab',
  // 弹窗白名单（主进程 → 渲染层：弹窗被连续拦截 N 次后提示用户加白）
  POPUP_DENIED: 'popup:denied',
  // 弹窗白名单（渲染层 → 主进程：添加 origin 到全局白名单）
  POPUP_ADD_WHITELIST: 'popup:addWhitelist',
  // 弹窗白名单（渲染层 → 主进程：添加 origin 到 Profile 专属白名单）
  POPUP_ADD_PROFILE_WHITELIST: 'popup:addProfileWhitelist',
  // AI Platform
  AI_PLATFORM_LIST: 'aiPlatform:list',
  // Prompt（明输入明注入）
  PROMPT_LIST: 'prompt:list',
  PROMPT_SAVE: 'prompt:save',
  PROMPT_DELETE: 'prompt:delete',
  // 导出全部提示词为 JSON 文件（主进程弹保存对话框 + 写文件）
  PROMPT_EXPORT: 'prompt:export',
  // 导入提示词 JSON 文件（主进程弹打开对话框 + 读文件 + 合并入库）
  PROMPT_IMPORT: 'prompt:import',
  // 打开提示词库独立窗口（单例）
  PROMPT_OPEN_WINDOW: 'prompt:openWindow',
  // 提示词注入请求（提示词库窗口 → 主进程 → 主窗口渲染：注入激活 webview）
  PROMPT_INJECT_REQUEST: 'prompt:injectRequest',
  // 注入结果回传（主进程 → 提示词库窗口：success + platformName）
  PROMPT_INJECT_RESULT: 'prompt:injectResult',
  // 注入历史（需求 2：注入预览 + Jaccard 去重）
  INJECTION_LOG: 'injection:log',
  INJECTION_LIST_RECENT: 'injection:listRecent',
  INJECTION_FIND_SIMILAR: 'injection:findSimilar',
  INJECTION_CLEAR: 'injection:clear',
  // 自定义 AI 提供商
  AI_PROVIDER_LIST: 'aiProvider:list',
  AI_PROVIDER_CREATE: 'aiProvider:create',
  AI_PROVIDER_UPDATE: 'aiProvider:update',
  AI_PROVIDER_DELETE: 'aiProvider:delete',
  AI_PROVIDER_TEST: 'aiProvider:test',
  AI_PROVIDER_LIST_MODELS: 'aiProvider:listModels',
  AI_PROVIDER_EXPORT_ENCRYPTED: 'aiProvider:exportEncrypted',
  AI_PROVIDER_IMPORT_ENCRYPTED: 'aiProvider:importEncrypted',
  // v0.5.2 B-4：预览导入（dry-run，返回 provider 列表 + 冲突 id，不持久化）
  AI_PROVIDER_PREVIEW_IMPORT: 'aiProvider:previewImport',
  // v0.5.2 B-4：写入加密导出文件到指定路径（渲染层提供路径 + 内容）
  AI_PROVIDER_WRITE_EXPORT_FILE: 'aiProvider:writeExportFile',
  // v0.5.2 B-4：读取导入文件内容（渲染层提供路径）
  AI_PROVIDER_READ_IMPORT_FILE: 'aiProvider:readImportFile',
  // v0.5.2 B-4：AI Provider 加密导出文件保存对话框
  AI_PROVIDER_SELECT_EXPORT_PATH: 'aiProvider:selectExportPath',
  // v0.5.2 B-4：AI Provider 加密导入文件打开对话框
  AI_PROVIDER_SELECT_IMPORT_FILE: 'aiProvider:selectImportFile',
  // 对话持久化（SQLite）
  CHAT_LIST_CONVERSATIONS: 'chat:listConversations',
  CHAT_CREATE_CONVERSATION: 'chat:createConversation',
  CHAT_GET_LAST_CONV_URL: 'chat:getLastConvUrl',
  CHAT_DELETE_CONVERSATION: 'chat:deleteConversation',
  CHAT_LIST_MESSAGES: 'chat:listMessages',
  CHAT_SAVE_MESSAGE: 'chat:saveMessage',
  CHAT_SAVE_MESSAGE_WITH_MERGE: 'chat:saveMessageWithMerge',
  CHAT_SEARCH: 'chat:search',
  CHAT_SEND: 'chat:send',
  CHAT_CANCEL: 'chat:cancel',
  CHAT_STREAM_CHUNK: 'chat:streamChunk',
  CHAT_STREAM_END: 'chat:streamEnd',
  // webview 抓取入库后通知主进程广播（渲染层 → 主进程）
  CHAT_NOTIFY_PERSISTED: 'chat:notifyPersisted',
  // 入库广播事件（主进程 → 所有窗口，HistoryView 订阅以实时刷新侧边栏）
  CHAT_CONVERSATION_PERSISTED: 'chat:conversationPersisted',
  CHAT_LOG_WINDOW_TRACE: 'chat:logWindowTrace',
  CHAT_LOG_LOGIN_TRACE: 'chat:logLoginTrace',
  CHAT_LIST_WINDOW_TRACES: 'chat:listWindowTraces',
  CHAT_LIST_LOGIN_TRACES: 'chat:listLoginTraces',
  // token 用量统计
  CHAT_GET_USAGE_STATS: 'chat:getUsageStats',
  // 对话导出（MD/JSON）
  CHAT_EXPORT_CONVERSATION: 'chat:exportConversation',
  // 对话导入（JSON / DeepSeek / MD）
  CHAT_IMPORT_CONVERSATION: 'chat:importConversation',
  // 清空所有对话
  CHAT_CLEAR_CONVERSATIONS: 'chat:clearConversations',
  // 清空登录痕迹 / 窗口操作痕迹
  CHAT_CLEAR_LOGIN_TRACES: 'chat:clearLoginTraces',
  CHAT_CLEAR_WINDOW_TRACES: 'chat:clearWindowTraces',
  // 使用统计与操作日志（启动时间 + data-name 点击日志）
  USAGE_TRACE_LOG_CLICK: 'usage-trace:logClick',
  USAGE_TRACE_GET_STATS: 'usage-trace:getStats',
  USAGE_TRACE_CLEAR: 'usage-trace:clear',
  USAGE_TRACE_LIST_APP_STARTS: 'usage-trace:listAppStarts',
  USAGE_TRACE_LIST_CLICK_LOGS: 'usage-trace:listClickLogs',
  // 主→渲染：设置窗口类型（用于点击日志的 windowType 字段）
  SET_WINDOW_TYPE: '__setWindowType__',
  // 更新消息
  CHAT_UPDATE_MESSAGE: 'chat:updateMessage',
  // 删除单条消息
  CHAT_DELETE_MESSAGE: 'chat:deleteMessage',
  // 更新会话标题
  CHAT_UPDATE_CONVERSATION: 'chat:updateConversation',
  // 创建自定义对话窗口
  CHAT_OPEN_WINDOW: 'chat:openWindow',
  // 打开历史搜索独立窗口（单例，列举所有本地保存数据）
  CHAT_OPEN_HISTORY_WINDOW: 'chat:openHistoryWindow',
  // 自定义对话脱离窗口管理（Alt+Q 切换）
  CHAT_LIST_DETACHED: 'chat:listDetached',
  CHAT_CREATE_DETACHED: 'chat:createDetached',
  CHAT_UPDATE_DETACHED: 'chat:updateDetached',
  CHAT_REMOVE_DETACHED: 'chat:removeDetached',
  CHAT_SHOW_DETACHED: 'chat:showDetached',
  CHAT_GET_CONFIG: 'chat:getConfig',
  // 主进程 → 主窗口：Alt+Q 无对话窗口时，请求打开配置
  CHAT_REQUEST_CONFIG: 'chat:requestConfig',
  // 底栏语音按钮触发（渲染→主：走后台语音路径，显示独立预览窗）
  VOICE_TRIGGER_START: 'voice:triggerStart',
  VOICE_TRIGGER_STOP: 'voice:triggerStop',
  // 后台语音注入+发送（主→最近聚焦窗口渲染：背景路径识别完成后注入 AI 输入框）
  // 载荷：{ text: string, enterToSend: boolean }
  VOICE_INJECT_AND_SEND: 'voice:injectAndSend',
  // 语音配置（enterToSend 等，全局设置）
  VOICE_GET_CONFIG: 'voice:getConfig',
  VOICE_SET_CONFIG: 'voice:setConfig',
  // 应用全局设置
  APP_GET_SETTINGS: 'app:getSettings',
  APP_UPDATE_SETTINGS: 'app:updateSettings',
  // 清除所有数据（恢复出厂设置，删除全部用户数据后重启）
  APP_CLEAR_ALL_DATA: 'app:clearAllData',
  // 数据迁移（导出/导入完整数据，跨设备迁移）
  APP_EXPORT_DATA: 'app:exportData',
  APP_IMPORT_DATA: 'app:importData',
  APP_IMPORT_DATA_DECRYPTED: 'app:importDataDecrypted',
  APP_SELECT_EXPORT_PATH: 'app:selectExportPath',
  APP_SELECT_IMPORT_FILE: 'app:selectImportFile',
  // 估算导出各类别体积（基础数据 / 登录态 / 完整分区 / 语音模型）
  APP_ESTIMATE_EXPORT_SIZES: 'app:estimateExportSizes',
  // 打开数据导出独立窗口（细粒度选择 + 体积提示）
  APP_OPEN_EXPORT_WINDOW: 'app:openExportWindow',
  // 清理缓存数据（仅缓存目录与 session cache，不动 cookies/localStorage/IndexedDB）
  APP_CLEAN_CACHE: 'app:cleanCache',
  // 估算当前缓存体积（字节）
  APP_ESTIMATE_CACHE_SIZE: 'app:estimateCacheSize',
  // 选择下载目录（弹出系统目录选择对话框）
  APP_SELECT_DOWNLOAD_DIR: 'app:selectDownloadDir',
  // 打开下载目录（在系统文件管理器中打开）
  APP_OPEN_DOWNLOAD_DIR: 'app:openDownloadDir',
  // 主→渲染：下载完成通知（filename + path）
  APP_DOWNLOAD_DONE: 'app:downloadDone',
  // 渲染→主：webview 文件拖拽导入（传递文件路径数组，返回 data URL 数组）
  WEBVIEW_FILE_DROP: 'webview:fileDrop',
  // 主→渲染：UI 比例变化广播（设置面板修改 uiScale 后，各窗口重新计算最小尺寸）
  UI_SCALE_CHANGED: 'app:uiScaleChanged',
  // 主→渲染：应用设置变更广播（任意窗口修改设置后，通知所有窗口同步更新）
  APP_SETTINGS_CHANGED: 'app:settingsChanged',
  // 主→渲染：UI 版本/主题变更广播（Oxy Design System 切换 / 主题模式切换后通知所有窗口）
  APP_UI_VERSION_CHANGED: 'app:uiVersionChanged',
  // 主→渲染：Oxy 主题色变更广播（切换 AI 应用时通知所有窗口同步主题色）
  APP_THEME_COLOR_CHANGED: 'app:themeColorChanged',
  // 代理测试（渲染层 → 主进程：测试当前代理配置连通性）
  APP_TEST_PROXY: 'app:testProxy',
  // 代理即时生效（渲染层 → 主进程：设置变更后将代理应用到所有 session）
  APP_APPLY_PROXY: 'app:applyProxy',
  // 代理失败兜底（渲染层 → 主进程：webview 加载失败时代理错误码触发，临时切换到兜底模式）
  // 返回 { switched: boolean, mode: 'direct' | 'system' | null }
  APP_PROXY_FALLBACK: 'app:proxyFallback',
  // Profile 级代理测试（渲染层 → 主进程：测试指定 Profile 的代理连通性）
  // 参数：profileId，返回 { ok, latencyMs?, message }
  APP_TEST_PROFILE_PROXY: 'app:testProfileProxy',
  // Profile 级代理即时生效（渲染层 → 主进程：将 Profile.proxyConfig 应用到其 session）
  // 参数：profileId
  APP_APPLY_PROFILE_PROXY: 'app:applyProfileProxy',
  // Profile 级代理失败兜底（渲染层 → 主进程：浏览器窗口 webview 加载失败时触发）
  // 参数：profileId，返回 { switched, mode }
  APP_PROFILE_PROXY_FALLBACK: 'app:profileProxyFallback',
  // 预览窗更新（主→预览窗渲染）
  PREVIEW_UPDATE: 'preview:update',
  PREVIEW_HIDE: 'preview:hide',
  // 流式识别部分结果（主→预览窗渲染：实时推送已识别的部分文本）
  PREVIEW_PARTIAL: 'preview:partial',
  // 渲染进程音频采集（主→预览窗渲染：开始/停止录音；渲染→主：回传 PCM 数据）
  VOICE_RECORD_START: 'voice:recordStart',
  VOICE_RECORD_STOP: 'voice:recordStop',
  VOICE_RECORD_DATA: 'voice:recordData',
  // 测试 AI 接入配置连通性（渲染层 → 主进程：发送静音样本验证；主进程 → 渲染层：返回结果）
  VOICE_TEST_AI: 'voice:testAi',
  // 渲染层请求强制停止当前录音（主进程 keyup 丢失时由 RecordIndicator 客户端兜底触发）
  VOICE_FORCE_STOP: 'voice:forceStop',
  // 麦克风设备列表（渲染层 → 主进程：上报 enumerateDevices 结果；主进程 → 渲染层：拉取最新列表）
  VOICE_INPUT_DEVICES_UPDATE: 'voice:inputDevicesUpdate',
  VOICE_INPUT_DEVICES_REFRESH: 'voice:inputDevicesRefresh',
  // v0.5.2 regress-2：测试 TTS 配置连通性（渲染层 → 主进程：发送短文本合成请求；返回 { ok, message, audioDataUrl? }）
  VOICE_TEST_TTS: 'voice:testTts',
  // 页面组件屏蔽规则
  BLOCK_RULES_LIST: 'blockRules:list',
  BLOCK_RULES_SAVE: 'blockRules:save',
  BLOCK_RULES_DELETE: 'blockRules:delete',
  BLOCK_RULES_UPDATE: 'blockRules:update',
  // AI 应用编辑窗口
  AI_APP_EDITOR_OPEN: 'ai-app-editor:open',
  // 设置独立窗口（单例）
  SETTINGS_WINDOW_OPEN: 'settings-window:open',
  // 历史记录与下载管理独立窗口（单例）
  HISTORY_DOWNLOAD_OPEN: 'history-download:open',
  // 进阶面板（单例，承载内置 AI/自定义供应商/自定义对话）
  ADVANCED_PANEL_OPEN: 'advancedPanel:open',
  ADVANCED_PANEL_TOGGLE: 'advancedPanel:toggle',
  // 主进程 → 进阶面板渲染：单例窗口复用时通知切换 tab/provider
  // 载荷：{ tab: string, providerId?: string }
  ADVANCED_PANEL_NAVIGATE: 'advancedPanel:navigate',
  // 主→渲染：webview 内应用快捷键转发（主进程 before-input-event 拦截后通知渲染层执行）
  // 载荷：{ action: 'switchTab' | 'cycleTab' | 'toggleSpatialNav' | 'openShortcuts' | 'toggleTheme' | 'navBack' | 'navForward' | 'navRefresh' | 'newTab' | 'closeTab', data?: unknown }
  WEBVIEW_HOTKEY: 'webview:hotkey',
  // 主→渲染：webview 弹窗 URL 转发（主进程拦截 window.open / target="_blank" 后，
  // 将 URL 发回渲染层，由渲染层在当前 webview 内导航，避免弹出独立窗口）
  // 载荷：{ url: string, webContentsId: number }
  WEBVIEW_POPUP_URL: 'webview:popupUrl',
  // 平台能力查询（设置页显示权限状态）
  PLATFORM_CAPABILITIES: 'platform:capabilities',
  // 引导（首次启动引导窗）
  ONBOARDING_SHOW: 'onboarding:show',
  ONBOARDING_IS_COMPLETED: 'onboarding:isCompleted',
  ONBOARDING_COMPLETE: 'onboarding:complete',
  // 灵感笔记（v2：SQLite + FTS5 + 富文本 + 分类）
  NOTES_LIST: 'notes:list',                   // 支持 filter: {keyword?, tag?, pinnedOnly?}
  NOTES_SEARCH: 'notes:search',               // 全文搜索（keyword）
  NOTES_SAVE: 'notes:save',                   // upsert
  NOTES_SAVE_SYNC: 'notes:saveSync',          // beforeunload 同步保存兜底（sendSync）
  NOTES_DELETE: 'notes:delete',
  NOTES_GET_ACTIVE: 'notes:getActive',
  NOTES_SET_ACTIVE: 'notes:setActive',
  NOTES_SET_PINNED: 'notes:setPinned',
  NOTES_SET_TAGS: 'notes:setTags',
  NOTES_LIST_TAGS: 'notes:listTags',
  // 笔记 → 当前 AI 输入框（主进程查找 lastFocusedWin 内的活跃 webview 注入）
  NOTES_SEND_TO_AI: 'notes:sendToAi',
  // 笔记 → 提示词库
  NOTES_SAVE_AS_PROMPT: 'notes:saveAsPrompt',
  // 主进程 → 笔记窗口渲染：注入结果回传（success + platformName?）
  NOTES_INJECT_RESULT: 'notes:injectResult',
  // 笔记图片保存（渲染层 → 主进程：dataURL → notes-asset:// 路径）
  NOTES_SAVE_IMAGE: 'notes:saveImage',
  // 白板（v3：SQLite + Excalidraw + 多白板）
  WHITEBOARD_LIST: 'whiteboard:list',
  WHITEBOARD_CREATE: 'whiteboard:create',
  WHITEBOARD_RENAME: 'whiteboard:rename',
  WHITEBOARD_DELETE: 'whiteboard:delete',
  WHITEBOARD_REORDER: 'whiteboard:reorder',
  WHITEBOARD_GET_ACTIVE: 'whiteboard:getActive',
  WHITEBOARD_SET_ACTIVE: 'whiteboard:setActive',
  WHITEBOARD_GET_SNAPSHOT: 'whiteboard:getSnapshot',
  WHITEBOARD_SAVE_SNAPSHOT: 'whiteboard:saveSnapshot',
  // 同步保存（beforeunload 兜底，确保窗口关闭前完成写入）
  WHITEBOARD_SAVE_SNAPSHOT_SYNC: 'whiteboard:saveSnapshotSync',
  // 渲染→主：保存截图 dataURL 到磁盘，返回 whiteboard-asset:// 路径（需求 12：截图到白板）
  WHITEBOARD_SAVE_IMAGE: 'whiteboard:saveImage',
  // 渲染→主：推送截图到白板（打开进阶面板 + 切到白板 tab + 转发载荷）
  WHITEBOARD_PUSH_IMAGE_REQUEST: 'whiteboard:pushImageRequest',
  // 主→渲染：白板窗口接收推送的截图（载荷：{ assetUrl, sourceUrl?, platform? }）
  WHITEBOARD_PUSH_IMAGE: 'whiteboard:pushImage',
  // 主进程 → AdvancedPanelView 渲染：通知切换到 whiteboard tab
  STANDALONE_SWITCH_TO_WHITEBOARD: 'standalone:switchToWhiteboard',
  // ===== 浏览器窗口（v0.0.9：多标签浏览器） =====
  // 窗口状态
  BROWSER_GET_STATE: 'browser:getState',
  BROWSER_SAVE_STATE: 'browser:saveState',
  // 标签操作（渲染→主，主进程只做持久化与窗口级动作）
  BROWSER_NEW_TAB: 'browser:newTab',
  BROWSER_CLOSE_TAB: 'browser:closeTab',
  BROWSER_SWITCH_TAB: 'browser:switchTab',
  BROWSER_NAVIGATE: 'browser:navigate',
  // 在系统默认浏览器中打开 URL
  BROWSER_OPEN_EXTERNAL: 'browser:openExternal',
  // 另存为：保存当前页面（渲染→主，webContentsId + suggestedName，主进程弹保存对话框后 savePage）
  BROWSER_SAVE_PAGE_AS: 'browser:savePageAs',
  // 另存为：下载 URL 到用户指定路径（渲染→主，webContentsId + url + suggestedFilename，will-download 弹保存对话框）
  BROWSER_DOWNLOAD_AS: 'browser:downloadAs',
  // 查看网页源代码：按 session partition 抓取原始 HTML（渲染→主，partition + url，返回源码文本）
  BROWSER_VIEW_SOURCE: 'browser:viewSource',
  // 打印预览：生成当前页面 PDF 临时文件（渲染→主，webContentsId + title，返回文件路径）
  BROWSER_PRINT_PREVIEW: 'browser:printPreview',
  // 打印预览页「另存为」：把临时 PDF 复制到用户指定路径
  BROWSER_SAVE_PDF_AS: 'browser:savePdfAs',
  // 删除打印预览临时文件（预览标签关闭时清理）
  BROWSER_DELETE_TEMP_PDF: 'browser:deleteTempPdf',
  // 云游戏备用方案：把系统光标重置到指定屏幕坐标（指针锁定不可用时的光标居中）
  CURSOR_SET: 'cursor:set',
  // 云电脑模式（渲染→主：进入/退出；主进程挂起/恢复全局热键、同步全屏）
  BROWSER_CLOUD_PC_SET: 'browser:cloudPc:set',
  // 云电脑模式状态变化（主→渲染：含主进程兜底退出通知）
  BROWSER_CLOUD_PC_CHANGED: 'browser:cloudPc:changed',
  // 云电脑模式系统级按键路由（主→渲染：Win/Alt+Tab/Win+Tab/Win+D/Alt+F4，渲染层合成注入 guest）
  BROWSER_CLOUD_PC_KEYS: 'browser:cloudPc:keys',
  // 全局光标屏幕坐标（渲染→主；全屏悬浮退出条的光标探测用）
  BROWSER_CURSOR_POS: 'browser:cursorPos',
  // 网页截图：保存截图 PNG 到用户指定路径（渲染→主，dataURL + suggestedName）
  BROWSER_SAVE_CAPTURE: 'browser:saveCapture',
  // 搜索历史
  BROWSER_SEARCH_HISTORY_ADD: 'browser:searchHistory:add',
  BROWSER_SEARCH_HISTORY_LIST: 'browser:searchHistory:list',
  // 下载记录
  BROWSER_DOWNLOAD_LIST: 'browser:download:list',
  BROWSER_DOWNLOAD_OPEN_FILE: 'browser:download:openFile',
  BROWSER_DOWNLOAD_SHOW_IN_FOLDER: 'browser:download:showInFolder',
  // 删除单条下载记录
  BROWSER_DOWNLOAD_DELETE: 'browser:download:delete',
  // 清空全部下载记录（可选按 windowId 过滤）
  BROWSER_DOWNLOAD_CLEAR_ALL: 'browser:download:clearAll',
  // 主→渲染：下载状态变化推送（BrowserDownloadRecord）
  BROWSER_DOWNLOAD_UPDATED: 'browser:download:updated',
  // 主→渲染：F12 切换 DevTools（浏览器窗口内 webview 焦点时主进程拦截转发）
  BROWSER_TOGGLE_DEVTOOLS: 'browser:toggleDevTools',
  // 主→渲染：F11 切换全屏（同上）
  BROWSER_TOGGLE_FULLSCREEN: 'browser:toggleFullscreen',
  // 主→渲染：脱离完成，通知源窗口关闭 tab（载荷：tabId）
  BROWSER_TAB_DETACHED: 'browser:tabDetached',
  // 浏览器窗口关闭时，将当前标签迁移回主窗口（渲染→主→主窗口渲染）
  BROWSER_TAB_MIGRATE_BACK: 'browser:tabMigrateBack',
  // ===== 导航历史追踪（主窗口渲染 → 主进程，内存存储） =====
  NAV_HISTORY_RECORD: 'navHistory:record',
  NAV_HISTORY_GET: 'navHistory:get',
  NAV_HISTORY_CLEAR: 'navHistory:clear',
  // 导航历史持久化（SQLite）CRUD：分页列表 / 关键词搜索 / 删除单条 / 清空（可选按 profileId）
  NAV_HISTORY_LIST: 'navHistory:list',
  NAV_HISTORY_SEARCH: 'navHistory:search',
  NAV_HISTORY_DELETE: 'navHistory:delete',
  NAV_HISTORY_CLEAR_ALL: 'navHistory:clearAll',
  // ===== 书签系统（v0.0.9，SQLite 持久化） =====
  // 渲染→主：查询书签列表（filter?: {profileId?, barOnly?}）
  BOOKMARK_LIST: 'bookmark:list',
  // 渲染→主：新增书签（BookmarkInput）
  BOOKMARK_ADD: 'bookmark:add',
  // 渲染→主：更新书签（{id, patch: BookmarkPatch}）
  BOOKMARK_UPDATE: 'bookmark:update',
  // 渲染→主：删除书签（id）
  BOOKMARK_DELETE: 'bookmark:delete',
  // 渲染→主：重排序书签（{ids: string[]}）
  BOOKMARK_REORDER: 'bookmark:reorder',
  // ===== 浏览器标签音频（v0.0.9） =====
  // 渲染→主：设置标签静音（{windowId, tabId, muted}）
  BROWSER_TAB_SET_MUTED: 'browser:tab:setMuted',
  // 主→渲染：标签音频状态变化推送（{windowId, tabId, audible}）
  BROWSER_TAB_AUDIO_CHANGED: 'browser:tab:audioChanged',
  // ===== 跨窗口标签聚合查询（v0.0.9，主子标签归属） =====
  // 渲染→主：查询所有窗口的标签树（返回 {main: TabState[], browsers: {windowId, parentTabId, profileId, tabs}[]}）
  BROWSER_FOCUS_WINDOW: 'browser:focusWindow',
  BROWSER_TABS_QUERY: 'browser:tabs:query',
  // ===== 浏览器窗口脱离/回归快捷键（每应用独立） =====
  // 渲染→主：保存/清除指定 Profile 的浏览器窗口快捷键（{ profileId, accelerator: string | null }）
  // 主进程保存到 Profile.browserWindowShortcut 并重注册全局快捷键
  PROFILE_SHORTCUT_SET: 'profile:shortcut:set',
  // ===== 累积链接（E1：AI 应用内新窗口链接累积） =====
  // 渲染→主：添加一条累积链接（profileId, url, title）
  ACCUMULATED_LINK_ADD: 'accumulated-link:add',
  // 渲染→主：列出指定 Profile 的全部累积链接
  ACCUMULATED_LINK_LIST: 'accumulated-link:list',
  // 渲染→主：取出并清空指定 Profile 的全部累积链接
  ACCUMULATED_LINK_CONSUME: 'accumulated-link:consume',
  // 渲染→主：清空指定 Profile 的全部累积链接
  ACCUMULATED_LINK_CLEAR: 'accumulated-link:clear',
  // ===== 页面冻结（v0.1.0 防撤回保险：Debugger.pause 冻结 webview） =====
  // 渲染→主：注册 webview 到冻结注册表（did-attach-webview 后渲染层上报 { tabId, windowId, profileId, webContentsId }）
  FREEZE_REGISTER_WEBVIEW: 'freeze:registerWebview',
  // 渲染→主：冻结指定 tab（先抓取对话入库再 pause，返回冻结结果 + 抓取到的对话快照）
  FREEZE_TAB: 'freeze:tab',
  /** 按主进程真实状态冻结或恢复，避免渲染层缓存状态竞态 */
  FREEZE_TOGGLE: 'freeze:toggle',
  // 渲染→主：恢复指定 tab（解除冻结，页面无缝继续）
  FREEZE_RESUME: 'freeze:resume',
  // 渲染→主：彻底分离调试器（退出冻结模式）
  FREEZE_DETACH: 'freeze:detach',
  // 渲染→主：查询冻结状态（返回 'idle' | 'attached' | 'frozen'）
  FREEZE_STATUS: 'freeze:status',
  // 主→渲染：冻结状态变化推送（{ tabId, state }）
  FREEZE_STATE_CHANGED: 'freeze:stateChanged',
  // 渲染→主：冻结态滚轮转发（选择层收到滚轮 → guest compositor 滚动画面）
  FREEZE_SCROLL: 'freeze:scroll',
  // 渲染→主：冻结态应用内置复制（选中文本 → 主进程写系统剪贴板）
  FREEZE_COPY_TEXT: 'freeze:copyText',
  // ===== 模块管理（插件系统：插件市场 / 开发者选项） =====
  // 渲染→主：列出全部模块信息（含状态）
  MODULE_LIST: 'module:list',
  // 渲染→主：启用/禁用模块（{ id, enabled }）
  MODULE_SET_ENABLED: 'module:setEnabled',
  // 渲染→主：清除模块数据（{ id }，不可逆）
  MODULE_CLEAR_DATA: 'module:clearData',
  // 主→渲染：模块状态变更广播（ModuleStateChangedPayload）
  MODULE_STATE_CHANGED: 'module:stateChanged',
  // 渲染→主：零残留诊断扫描（返回 ResidualScanResult）
  MODULE_DIAGNOSTICS: 'module:diagnostics',
} as const
