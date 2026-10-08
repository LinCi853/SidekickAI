// Pure installation data projected from the application's modules and defaults.
// The generator evaluates this entry without starting the application and writes
// release metadata under build. The packaged wizard reads its embedded metadata.
// Imports must remain free of application startup side effects.

import { installationComponents, installationPolicy } from '../../installer-shared/edition-policy.js'
import { BUILTIN_MODULE_INSTALL_DATA } from '../modules/builtin-module-data.js'
import { getDefaultAppSettings } from '../store/default-config.js'

export interface InstallManifestFeature {
  id: string
  name: string
  description: string
  category: string
  defaultEnabled: boolean
  /** A core module that cannot be disabled. */
  required?: boolean
  /** An optional component selected before installation. */
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
  /** The wizard page for this option. */
  page?: string
}

/** Project only components owned by the selected edition. */
export const INSTALL_MANIFEST_FEATURES: InstallManifestFeature[] = installationComponents(BUILTIN_MODULE_INSTALL_DATA).map(
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

/** Wizard option labels and grouping. */
const OPTION_META: Array<
  Omit<InstallManifestOption, 'defaultValue'>
> = [
  {
    id: 'autoUpdate',
    label: installationPolicy.updateLabel,
    description: installationPolicy.updateDescription,
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

/** Default values come from the application settings contract. */
const DEFAULTS = getDefaultAppSettings(false)
const OPTION_DEFAULTS: Record<string, boolean | string> = {
  autoUpdate: DEFAULTS.autoUpdate,
  autoLaunch: DEFAULTS.autoLaunch,
  logLevel: DEFAULTS.logLevel,
  usageTracking: DEFAULTS.usageTrackingEnabled,
}

export const INSTALL_MANIFEST_OPTIONS: InstallManifestOption[] = OPTION_META.filter(option => installationPolicy.options.includes(option.id)).map((m) => ({
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
