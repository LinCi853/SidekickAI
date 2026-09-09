// electron/store/install-config-seed.ts — 安装期配置播种
//
// 安装向导（installer/）在安装阶段把用户选择写入 install-config.json，由提权后的
// NSIS 拷贝到 $INSTDIR（exe 同级）。本模块在应用首次启动时读取它，把：
//   1. 功能开关（modules）→ 模块启用状态（module_state 表）
//   2. 应用选项（options）→ 全局设置（app_settings 表）
// 写入 SQLite settings.db，随后用 meta 标记「已消费」，保证只播种一次。
//
// "安装完成后永不改动"：播种仅在首次启动发生；之后用户在应用内的任何修改都
// 持久化在 settings.db 中，不会再被安装期配置覆盖。settings.db 位于 userData，
// 跨版本更新持续存在，因此后续更新也不会重置用户设置。

import { app } from 'electron'
import path from 'path'
import { existsSync, readFileSync } from 'fs'
import { isPortableMode } from './store-paths.js'
import {
  getAppSettingsTable,
  getModuleState,
  isLargeModuleInstalledByManifestFile,
  saveModuleState,
} from './module-state-store.js'
import { applyInstallConfigOptions } from './app-settings-store.js'

/** 安装期配置文件名（exe 同级，NSIS 写入） */
export const INSTALL_CONFIG_FILENAME = 'install-config.json'
/** 已消费标记（写入 settings.db / app_settings，避免重复播种） */
const APPLIED_FLAG_KEY = 'installConfigApplied'

interface InstallConfig {
  schemaVersion: number
  modules: Record<string, { enabled: boolean }>
  options: Record<string, boolean | string>
}

/** 读取安装期配置；不存在或解析失败返回 null */
function readInstallConfig(): InstallConfig | null {
  try {
    const configPath = path.join(path.dirname(app.getPath('exe')), INSTALL_CONFIG_FILENAME)
    if (!existsSync(configPath)) return null
    const raw = readFileSync(configPath, 'utf-8')
    const cfg = JSON.parse(raw) as InstallConfig
    if (!cfg || typeof cfg !== 'object') return null
    return cfg
  } catch (err) {
    console.warn('[install-config] 读取安装期配置失败:', err)
    return null
  }
}

/** 播种模块启用状态（仅对尚无状态的模块；已有状态表示用户已启动过，不覆盖） */
function seedModuleStates(modules: Record<string, { enabled: boolean }>): void {
  let seeded = 0
  for (const [id, cfg] of Object.entries(modules)) {
    if (!cfg || typeof cfg.enabled !== 'boolean') continue
    if (getModuleState(id)) continue // 已有状态，保留用户选择
    // installed 与大模块安装清单一致（非大模块恒 true）
    const installed = isLargeModuleInstalledByManifestFile(id)
    saveModuleState({
      id,
      enabled: cfg.enabled && installed, // 大模块未安装时强制禁用
      installed,
      clearedAt: 0,
      updatedAt: Date.now(),
    })
    seeded += 1
  }
  if (seeded > 0) console.log(`[install-config] 已播种 ${seeded} 个模块状态`)
}

/**
 * 首次启动入口：在 initEnabledModules() 与首次读取设置之前调用。
 * 便携版跳过（便携版无 NSIS 安装、配置不适用）。
 */
export function seedFromInstallConfig(): void {
  if (isPortableMode()) return
  try {
    const meta = getAppSettingsTable()
    if (meta.get(APPLIED_FLAG_KEY) === '1') return // 已消费过
    const cfg = readInstallConfig()
    if (!cfg) return // 无安装期配置（旧安装 / 直接解压），使用默认值
    seedModuleStates(cfg.modules ?? {})
    applyInstallConfigOptions(cfg.options ?? {})
    meta.set(APPLIED_FLAG_KEY, '1')
    console.log('[install-config] 安装期配置已消费')
  } catch (err) {
    console.warn('[install-config] 播种失败:', err)
  }
}
