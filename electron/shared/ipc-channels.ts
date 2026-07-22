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
  // 窗口重新展示（主进程 → 渲染层：脱离窗口被 Alt+Q 显示时通知刷新 webview）
  WINDOW_SHOWN: 'window:shown',
  WINDOW_HIDDEN: 'window:hidden',
  // 新标签页（主进程 → 渲染层：拦截 webview 弹窗后通知渲染层新建标签）
  RENDERER_NEW_TAB: 'renderer:newTab',
  // AI Platform
  AI_PLATFORM_LIST: 'aiPlatform:list',
  // Prompt（明输入明注入）
  PROMPT_LIST: 'prompt:list',
  PROMPT_SAVE: 'prompt:save',
  PROMPT_DELETE: 'prompt:delete',
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
  // 无头浏览器
  HEADLESS_IS_RUNNING: 'headless:isRunning',
  HEADLESS_VERSION: 'headless:version',
  HEADLESS_CLOSE: 'headless:close',
  HEADLESS_CREATE_PAGE: 'headless:createPage',
  HEADLESS_CLOSE_PAGE: 'headless:closePage',
  HEADLESS_LIST_PAGES: 'headless:listPages',
  HEADLESS_GET_PAGE_INFO: 'headless:getPageInfo',
  HEADLESS_NAVIGATE: 'headless:navigate',
  HEADLESS_SCREENSHOT: 'headless:screenshot',
  HEADLESS_PDF: 'headless:pdf',
  HEADLESS_EVALUATE: 'headless:evaluate',
  // 语音热键（主→渲染：uiohook 监听 Alt+V keydown/keyup 转发）
  VOICE_HOTKEY_DOWN: 'voice:hotkeyDown',
  VOICE_HOTKEY_UP: 'voice:hotkeyUp',
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
  // 代理测试（渲染层 → 主进程：测试当前代理配置连通性）
  APP_TEST_PROXY: 'app:testProxy',
  // 代理即时生效（渲染层 → 主进程：设置变更后将代理应用到所有 session）
  APP_APPLY_PROXY: 'app:applyProxy',
  // 代理失败兜底（渲染层 → 主进程：webview 加载失败时代理错误码触发，临时切换到兜底模式）
  // 返回 { switched: boolean, mode: 'direct' | 'system' | null }
  APP_PROXY_FALLBACK: 'app:proxyFallback',
  // 预览窗更新（主→预览窗渲染）
  PREVIEW_UPDATE: 'preview:update',
  PREVIEW_HIDE: 'preview:hide',
  // 渲染进程音频采集（主→预览窗渲染：开始/停止录音；渲染→主：回传 PCM 数据）
  VOICE_RECORD_START: 'voice:recordStart',
  VOICE_RECORD_STOP: 'voice:recordStop',
  VOICE_RECORD_DATA: 'voice:recordData',
  // 语音模型/引擎下载（渲染层 → 主进程：触发下载；主进程 → 渲染层：推送进度）
  VOICE_DOWNLOAD_MODEL: 'voice:downloadModel',
  VOICE_DOWNLOAD_WHISPER_CLI: 'voice:downloadWhisperCli',
  VOICE_DOWNLOAD_PROGRESS: 'voice:downloadProgress',
  // 测试 AI 接入配置连通性（渲染层 → 主进程：发送静音样本验证；主进程 → 渲染层：返回结果）
  VOICE_TEST_AI: 'voice:testAi',
  // 渲染层请求强制停止当前录音（主进程 keyup 丢失时由 RecordIndicator 客户端兜底触发）
  VOICE_FORCE_STOP: 'voice:forceStop',
  // builtin 模式 Web Speech API 识别（主→渲染：通知渲染层启动 webkitSpeechRecognition）
  VOICE_BUILTIN_START: 'voice:builtinStart',
  // builtin 模式识别结果回传（渲染→主：携带识别到的文本）
  VOICE_BUILTIN_RESULT: 'voice:builtinResult',
  // builtin 模式识别错误回传（渲染→主：携带错误信息）
  VOICE_BUILTIN_ERROR: 'voice:builtinError',
  // 麦克风设备列表（渲染层 → 主进程：上报 enumerateDevices 结果；主进程 → 渲染层：拉取最新列表）
  VOICE_INPUT_DEVICES_UPDATE: 'voice:inputDevicesUpdate',
  VOICE_INPUT_DEVICES_REFRESH: 'voice:inputDevicesRefresh',
  // 渲染层 → 主进程：检查 whisper-cli 二进制文件是否实际存在（不依赖 cfg.downloadStatus）
  VOICE_CHECK_CLI_EXISTS: 'voice:checkCliExists',
  // 渲染层 → 主进程：检查单个模型文件是否实际存在（按 modelId，如 'whisper-tiny'）
  VOICE_CHECK_MODEL_EXISTS: 'voice:checkModelExists',
  // 渲染层 → 主进程：列出所有已下载的模型 id（扫描 userData/models/ 目录）
  // 用于设置页 mount 时纠正 downloadedModels 数组（解决"已下载却仍提示下载"）
  VOICE_LIST_DOWNLOADED_MODELS: 'voice:listDownloadedModels',
  // 卸载 whisper-cli 引擎二进制（删除 userData/bin/ 下的可执行文件 + 修正 cfg.cliDownloaded=false）
  VOICE_UNINSTALL_WHISPER_CLI: 'voice:uninstallWhisperCli',
  // 卸载指定 whisper 模型文件（删除 userData/models/ggml-*.bin + 从 cfg.downloadedModels 移除）
  VOICE_UNINSTALL_MODEL: 'voice:uninstallModel',
  // v0.5.2 regress-2：测试 TTS 配置连通性（渲染层 → 主进程：发送短文本合成请求；返回 { ok, message, audioDataUrl? }）
  VOICE_TEST_TTS: 'voice:testTts',
  // 页面组件屏蔽规则
  BLOCK_RULES_LIST: 'blockRules:list',
  BLOCK_RULES_SAVE: 'blockRules:save',
  BLOCK_RULES_DELETE: 'blockRules:delete',
  BLOCK_RULES_UPDATE: 'blockRules:update',
  // AI 应用编辑窗口
  AI_APP_EDITOR_OPEN: 'ai-app-editor:open',
  // AI 应用独立窗口（单例，承载内置 AI/自定义供应商/自定义对话）
  AI_APP_PROVIDER_OPEN: 'aiAppProvider:open',
  AI_APP_PROVIDER_TOGGLE: 'aiAppProvider:toggle',
  // 主进程 → AI 应用独立窗口渲染：单例窗口复用时通知切换 tab/provider
  // 载荷：{ tab: 'providers' | 'chat', providerId?: string }
  AI_APP_PROVIDER_NAVIGATE: 'aiAppProvider:navigate',
  // 主→渲染：webview 内应用快捷键转发（主进程 before-input-event 拦截后通知渲染层执行）
  // 载荷：{ action: 'switchTab' | 'cycleTab' | 'toggleSpatialNav' | 'openShortcuts' | 'toggleTheme' | 'navBack' | 'navForward' | 'navRefresh' | 'newTab' | 'closeTab', data?: unknown }
  WEBVIEW_HOTKEY: 'webview:hotkey',
  // 主→渲染：webview 弹窗 URL 转发（主进程拦截 window.open / target="_blank" 后，
  // 将 URL 发回渲染层，由渲染层在当前 webview 内导航，避免弹出独立窗口）
  // 载荷：{ url: string, webContentsId: number }
  WEBVIEW_POPUP_URL: 'webview:popupUrl',
  // 主→渲染：webview 弹窗被连续拒绝达阈值（默认3次），提示用户加白名单
  // 载荷：{ url: string, origin: string, count: number }
  WEBVIEW_POPUP_DENIED: 'webview:popupDenied',
  // 渲染→主：用户确认将 origin 加入白名单（持久化到 AppSettings.popupWhitelist）
  // 载荷：origin: string
  POPUP_WHITELIST_ADD: 'popup:whitelistAdd',
  // 平台能力查询（设置页显示权限状态）
  PLATFORM_CAPABILITIES: 'platform:capabilities',
  // 引导（首次启动引导窗）
  ONBOARDING_SHOW: 'onboarding:show',
  ONBOARDING_IS_COMPLETED: 'onboarding:isCompleted',
  ONBOARDING_COMPLETE: 'onboarding:complete',
  // 需求 11：灵感笔记（嵌入 StandaloneView，无独立窗口）
  NOTES_LIST: 'notes:list',
  NOTES_SAVE: 'notes:save',
  NOTES_DELETE: 'notes:delete',
  NOTES_GET_ACTIVE: 'notes:getActive',
  NOTES_SET_ACTIVE: 'notes:setActive',
  // 笔记 → 当前 AI 输入框（主进程查找 lastFocusedWin 内的活跃 webview 注入）
  NOTES_SEND_TO_AI: 'notes:sendToAi',
  // 笔记 → 提示词库
  NOTES_SAVE_AS_PROMPT: 'notes:saveAsPrompt',
  // 主进程 → 目标窗口渲染：笔记内容直接注入 AI 输入框（不弹预览，与 PROMPT_INJECT_REQUEST 区分）
  // 载荷：{ text: string, enterToSend: boolean }
  NOTES_INJECT_TEXT: 'notes:injectText',
  // 主进程 → 笔记窗口渲染：注入结果回传（success + platformName?）
  NOTES_INJECT_RESULT: 'notes:injectResult',
  // 需求 12：白板（嵌入 StandaloneView，无独立窗口）
  WHITEBOARD_GET_STATE: 'whiteboard:getState',
  WHITEBOARD_SAVE_STATE: 'whiteboard:saveState',
  WHITEBOARD_CLEAR: 'whiteboard:clear',
  // 主进程 → 白板窗口渲染：外部推送卡片（截图 / HistoryView 拖入消息）
  // 载荷：WhiteboardCardInput
  WHITEBOARD_PUSH_CARD: 'whiteboard:pushCard',
  // 渲染进程 → 主进程：从任意窗口（如 HistoryView）推送卡片到白板
  // 主进程接收后打开白板窗口（如未打开），生成完整 WhiteboardCard 并转发给白板渲染
  // 载荷：WhiteboardCardInput
  WHITEBOARD_PUSH_CARD_REQUEST: 'whiteboard:pushCardRequest',
  // 主进程 → StandaloneView 渲染：通知切换到 whiteboard 视图模式
  // v0.5.2：用于跨窗口推送卡片时自动激活白板视图
  STANDALONE_SWITCH_TO_WHITEBOARD: 'standalone:switchToWhiteboard',
  // v0.5.2 R-4：白板图片磁盘存储
  WHITEBOARD_SAVE_IMAGE: 'whiteboard:saveImage',
} as const
