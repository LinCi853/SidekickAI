// electron/shared/install-manifest-source.ts — 安装向导清单「单一数据源」投影
//
// 由 scripts/gen-install-manifest.cjs 经 esbuild 打包后执行，产出
// installer-tauri/src-tauri/install-manifest.json，安装向导（Rust/前端）均从此读取。
//
// 派生规则：
//  - 功能清单 ← builtin-module-data.ts（与主应用 BUILTIN_MODULES 同源）
//  - 选项清单 ← 显式元数据 + getDefaultAppSettings(false) 的默认值投影（保证与主应用默认一致）
//
// 本文件禁止引入任何有副作用的模块（仅允许纯数据导入），保证可被 Node 安全 require。

import { BUILTIN_MODULE_INSTALL_DATA } from '../modules/builtin-module-data.js'
import { getDefaultAppSettings } from '../store/default-config.js'

export interface InstallManifestFeature {
  id: string
  name: string
  description: string
  category: string
  defaultEnabled: boolean
  /** 不可关闭的核心模块 */
  required?: boolean
  /** 需独立安装才能使用（安装前选定，安装中不可调整） */
  installRequired?: boolean
  sizeLevel: string
}

export interface InstallManifestOptionChoice {
  value: string
  label: string
}

export interface InstallManifestOption {
  id: string
  label: string
  description: string
  type: string
  defaultValue: boolean | string | number
  choices?: InstallManifestOptionChoice[]
  /** 选项分组页（应用行为 / 日志）；空 = 不分页 */
  page?: string
}

/** 功能清单：直接由内置模块数据派生，模块增删/改名只需维护 builtin-module-data.ts */
export const INSTALL_MANIFEST_FEATURES: InstallManifestFeature[] = BUILTIN_MODULE_INSTALL_DATA.map(
  (d) => ({
    id: d.id,
    name: d.name,
    description: d.description,
    category: d.category,
    defaultEnabled: d.defaultEnabled,
    required: d.required || undefined,
    installRequired: d.installRequired || undefined,
    sizeLevel: d.sizeLevel,
  })
)

/** 选项元数据（id/label/描述/类型/分组）——安装向导独有的展示信息 */
const OPTION_META: Array<
  Omit<InstallManifestOption, 'defaultValue'>
> = [
  {
    id: 'autoUpdate',
    label: '自动更新',
    description: '预留：检查并应用更新（后续版本提供真实更新链路，当前仅保存偏好）',
    type: 'boolean',
    page: 'behavior',
  },
  {
    id: 'autoLaunch',
    label: '开机自启',
    description: '登录 Windows 后自动在后台启动',
    type: 'boolean',
    page: 'behavior',
  },
  {
    id: 'logLevel',
    label: '日志级别',
    description: '决定记录多少运行日志（debug 最详细）',
    type: 'choice',
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
    page: 'behavior',
  },
]

/** 默认值从主应用设置默认值投影（optionId → AppSettings 字段映射同 app-settings-store 播种逻辑） */
const DEFAULTS = getDefaultAppSettings(false)
const OPTION_DEFAULTS: Record<string, boolean | string> = {
  autoUpdate: DEFAULTS.autoUpdate,
  autoLaunch: DEFAULTS.autoLaunch,
  logLevel: DEFAULTS.logLevel,
  usageTracking: DEFAULTS.usageTrackingEnabled,
}

export const INSTALL_MANIFEST_OPTIONS: InstallManifestOption[] = OPTION_META.map((m) => ({
  ...m,
  defaultValue: OPTION_DEFAULTS[m.id] ?? false,
}))

export interface InstallManifestPayload {
  features: InstallManifestFeature[]
  options: InstallManifestOption[]
}

export const INSTALL_MANIFEST: InstallManifestPayload = {
  features: INSTALL_MANIFEST_FEATURES,
  options: INSTALL_MANIFEST_OPTIONS,
}