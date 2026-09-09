// installer/src/shared/install-manifest.ts
// 安装期「功能 / 选项」清单 —— 单一数据源
//
// 这份清单同时驱动：
//   1. 安装向导 UI：功能组件选择 + 安装选项
//   2. 安装器主进程：把用户选择写入 install-config.json
//   3. 主程序首启：读取 install-config.json 播种模块启用状态与全局选项
//
// 功能（features）与主程序 electron/modules/manifests.ts 的 BUILTIN_MODULES 一一对应。
// 新增插件/功能时：先在这里登记，再在 BUILTIN_MODULES 里实现，二者保持 id 一致。

export interface InstallFeature {
  /** 与 ModuleManifest.id 一致 */
  id: string
  /** 展示名称 */
  name: string
  /** 一句话说明 */
  description: string
  /** 稳定功能 / 实验功能（UI 分区用） */
  category: 'stable' | 'dev'
  /** 默认是否启用 */
  defaultEnabled: boolean
  /** 是否为核心功能（不可在安装期关闭；关闭会导致应用无法正常使用） */
  required?: boolean
}

export interface InstallOption {
  id: string
  label: string
  description: string
  type: 'boolean' | 'choice'
  defaultValue: boolean | string
  choices?: { value: string; label: string }[]
  /** 选项分组页（behavior / logging）；空 = 不分页 */
  page?: 'behavior' | 'logging'
}

/** 协议文档（用户许可 / 开源许可 / 隐私政策等），驱动协议页列表 + 独立阅读弹层 */
export interface LicenseDoc {
  id: string
  title: string
  /** 默认打开的协议（用户许可协议） */
  defaultOpen: boolean
  body: string
}

// ============================================================================
// 功能清单（与 BUILTIN_MODULES 对齐；顺序即展示顺序）
// ============================================================================
export const INSTALL_FEATURES: InstallFeature[] = [
  {
    id: 'whiteboard',
    name: '画板 / 白板',
    description: 'Excalidraw 无限画布：多白板管理、SQLite 持久化、截图推送到白板',
    category: 'stable',
    defaultEnabled: true,
  },
  {
    id: 'notes',
    name: '笔记',
    description: '富文本灵感笔记：任务列表、代码块、图片、全文搜索',
    category: 'stable',
    defaultEnabled: true,
  },
  {
    id: 'custom-chat',
    name: '自定义对话 API',
    description: 'OpenAI / Anthropic / Custom 三协议直连与流式对话',
    category: 'stable',
    defaultEnabled: true,
    required: true,
  },
  {
    id: 'prompt-library',
    name: '提示词库',
    description: '提示词模板管理、热键注入、注入历史去重',
    category: 'stable',
    defaultEnabled: true,
  },
  {
    id: 'browser',
    name: '多标签浏览器',
    description: 'Chrome 风格多标签浏览器窗口：标签 / 导航 / 书签 / 下载 / 历史',
    category: 'dev',
    defaultEnabled: false,
  },
  {
    id: 'voice',
    name: '语音输入',
    description: '后台语音：按住说话、STT 识别、分层上屏（实验性）',
    category: 'dev',
    defaultEnabled: false,
  },
  {
    id: 'tts',
    name: 'TTS 语音合成',
    description: '自定义供应商 TTS 合成（实验性，依赖自定义对话 API）',
    category: 'dev',
    defaultEnabled: false,
  },
  {
    id: 'freeze',
    name: '页面冻结（防撤回）',
    description: '冻结 AI 网页防止对方撤回 / 删除内容（实验性）',
    category: 'dev',
    defaultEnabled: false,
  },
]

// ============================================================================
// 安装选项（写入 install-config.json 的 options；id 对应 AppSettings 字段）
// ============================================================================
export const INSTALL_OPTIONS: InstallOption[] = [
  {
    id: 'autoUpdate',
    label: '自动更新',
    description: '有可用更新时自动下载并在下次启动时应用',
    type: 'boolean',
    defaultValue: true,
    page: 'behavior',
  },
  {
    id: 'autoLaunch',
    label: '开机自启',
    description: '登录 Windows 后自动在后台启动',
    type: 'boolean',
    defaultValue: false,
    page: 'behavior',
  },
  {
    id: 'logLevel',
    label: '日志级别',
    description: '决定记录多少运行日志（debug 最详细）',
    type: 'choice',
    defaultValue: 'debug',
    choices: [
      { value: 'error', label: '仅错误' },
      { value: 'warn', label: '警告及以上' },
      { value: 'info', label: '常规信息' },
      { value: 'debug', label: '调试（最详细）' },
    ],
    page: 'logging',
  },
  {
    id: 'usageTracking',
    label: '使用统计',
    description: '匿名收集使用数据以改进产品',
    type: 'boolean',
    defaultValue: true,
    page: 'behavior',
  },
]

// ============================================================================
// 便捷函数
// ============================================================================
export function getInstallFeatureDefaults(): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const f of INSTALL_FEATURES) out[f.id] = f.defaultEnabled
  return out
}

export function getInstallOptionDefaults(): Record<string, boolean | string> {
  const out: Record<string, boolean | string> = {}
  for (const o of INSTALL_OPTIONS) out[o.id] = o.defaultValue
  return out
}

/** 安装期配置文件的最终形态（写入 install-config.json） */
export interface InstallConfig {
  schemaVersion: number
  modules: Record<string, { enabled: boolean }>
  options: Record<string, boolean | string>
}
