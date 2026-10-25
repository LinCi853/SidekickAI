import type { AppSettings } from '../shared/api/settings.api.js'
import { ALL_TOP_BAR_BUTTON_GROUPS } from '../shared/api/settings-options.js'
import { getDefaultAppSettings } from './app-settings-defaults.js'
import { getAppSettingsTable } from './module-state-store.js'
import { isPortableMode } from './store-paths.js'
import { resetLowMemoryModeForTest, setLowMemoryMode } from './low-memory-mode.js'

const choices: Partial<Record<keyof AppSettings, readonly string[]>> = {
  proxyMode: ['system', 'direct', 'custom'],
  closeBehavior: ['close', 'minimize'],
  logLevel: ['error', 'warn', 'info', 'debug'],
  uiScale: ['small', 'medium', 'large'],
  themeMode: ['light', 'dark', 'system'],
  startupOpen: ['home', 'lastConversation'],
  appClickBehavior: ['switch', 'close'],
  cacheAutoClean: ['never', 'daily', 'weekly', 'monthly'],
  downloadBehavior: ['ask', 'auto'],
  proxyFallbackMode: ['direct', 'system'],
  browserTabPersistence: ['memory', 'persistent'],
}

let cache: AppSettings | null = null

/** 必须为非负整数的设置项（毫秒/分钟/次数/上限类数值不接受小数） */
const integerKeys: ReadonlySet<keyof AppSettings> = new Set([
  'altSpaceResetThreshold',
  'chatInputCursorPos',
])

function isValid(key: keyof AppSettings, value: unknown, defaults: AppSettings): boolean {
  const allowed = choices[key]
  if (allowed) return typeof value === 'string' && allowed.includes(value)
  const fallback = defaults[key]
  if (Array.isArray(fallback)) {
    return (
      Array.isArray(value) &&
      value.every(
        (item) =>
          typeof item === 'string' &&
          (key !== 'topBarVisibleButtons' ||
            (ALL_TOP_BAR_BUTTON_GROUPS as readonly string[]).includes(item)),
      )
    )
  }
  if (key === 'defaultSearchEngine') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const engine = value as Record<string, unknown>
    return typeof engine.name === 'string' && typeof engine.urlTemplate === 'string'
  }
  if (typeof fallback === 'number') {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      (!integerKeys.has(key) || Number.isInteger(value)) &&
      (key !== 'altSpaceResetThreshold' || value >= 1) &&
      (!key.endsWith('Width') || value > 0)
    )
  }
  return typeof value === typeof fallback
}

function validated(input: unknown, strict: boolean): Partial<AppSettings> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    if (strict) throw new Error('应用设置格式无效')
    return {}
  }
  const defaults = getDefaultAppSettings(isPortableMode())
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(defaults) as Array<keyof AppSettings>) {
    if (!Object.hasOwn(input, key)) continue
    const value = (input as Record<string, unknown>)[key]
    if (isValid(key, value, defaults)) result[key] = structuredClone(value)
    else if (strict) throw new Error(`应用设置值无效: ${key}`)
  }
  return result as Partial<AppSettings>
}

export function validateAppSettingsPatch(patch: unknown): Partial<AppSettings> {
  return validated(patch, true)
}

export function readSettingsRaw(): AppSettings {
  if (!cache) {
    const raw = getAppSettingsTable().get('appSettings')
    const defaults = getDefaultAppSettings(isPortableMode())
    if (raw != null) {
      try {
        cache = { ...defaults, ...validated(JSON.parse(raw), false) }
      } catch (error) {
        console.error('[app-settings] Cannot read persisted settings:', error)
        cache = defaults
      }
    } else {
      getAppSettingsTable().set('appSettings', JSON.stringify(defaults))
      cache = defaults
    }
  }
  // 低内存开关供窗口退役定时器高频读取，缓存在无依赖模块里，避免每次深拷贝全量设置。
  setLowMemoryMode(cache.lowMemoryMode)
  return structuredClone(cache)
}

export function writeSettingsRaw(next: AppSettings): void {
  getAppSettingsTable().set('appSettings', JSON.stringify(next))
  cache = structuredClone(next)
  setLowMemoryMode(cache.lowMemoryMode)
}

export function resetSettingsCacheForTest(): void {
  cache = null
  resetLowMemoryModeForTest()
}
