// electron/store/install-config-seed.ts — 安装期配置播种
//
// 安装向导（installer/）在安装阶段把用户选择写入 install-config.json，拷贝到 $INSTDIR
// （exe 同级）。本模块在应用启动时读取它，把：
//   1. 功能开关（modules）→ 模块启用状态（module_state 表）
//   2. 应用选项（options）→ 全局设置（app_settings 表）
// 写入 SQLite settings.db。
//
// 播种时机：install-config.json 内容哈希变化时执行（覆盖重装/修复写入了新选择的场景）。
// 同一哈希只应用一次；用户此后在应用内的修改不会被重复播种覆盖。
// 数据导入成功后会把当前哈希写入已恢复的 settings.db，避免导入结果被安装配置立刻改写。

import { app } from 'electron'
import path from 'path'
import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { isPortableMode } from './store-paths.js'
import {
  getAppSettingsTable,
  getModuleState,
  isLargeModuleInstalledByManifestFile,
  saveModuleState,
} from './module-state-store.js'
import { applyInstallConfigOptions } from './app-settings-store.js'

/** 安装期配置文件名（exe 同级） */
export const INSTALL_CONFIG_FILENAME = 'install-config.json'
/** 已应用的 install-config 内容哈希（sha256 hex）；变化时重新播种 */
const APPLIED_HASH_KEY = 'installConfigHash'
/** 旧版一次性消费标记（迁移用，读到后清理） */
const LEGACY_APPLIED_FLAG_KEY = 'installConfigApplied'

interface InstallConfig {
  schemaVersion: number
  modules: Record<string, { enabled: boolean }>
  options: Record<string, boolean | string>
}

function hashBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** 读取安装期配置原始字节与解析结果；不存在返回 null */
export function readInstallConfigRaw(): { raw: Buffer; cfg: InstallConfig; hash: string } | null {
  try {
    const configPath = path.join(path.dirname(app.getPath('exe')), INSTALL_CONFIG_FILENAME)
    if (!existsSync(configPath)) return null
    const raw = readFileSync(configPath)
    const cfg = JSON.parse(raw.toString('utf-8')) as InstallConfig
    if (!cfg || typeof cfg !== 'object') return null
    return { raw, cfg, hash: hashBuffer(raw) }
  } catch (err) {
    console.warn('[install-config] 读取安装期配置失败:', err)
    return null
  }
}

/** 当前磁盘上 install-config.json 的内容哈希；无文件返回 null */
export function getInstallConfigHash(): string | null {
  return readInstallConfigRaw()?.hash ?? null
}

/**
 * 播种模块状态。
 * @param force 为 true 时覆盖已有状态（重装/配置变更后的重新播种）
 */
function seedModuleStates(modules: Record<string, { enabled: boolean }>, force: boolean): void {
  let seeded = 0
  for (const [id, cfg] of Object.entries(modules)) {
    if (!cfg || typeof cfg.enabled !== 'boolean') continue
    if (!force && getModuleState(id)) continue
    const installed = isLargeModuleInstalledByManifestFile(id)
    saveModuleState({
      id,
      enabled: cfg.enabled && installed,
      installed,
      clearedAt: 0,
      updatedAt: Date.now(),
    })
    seeded += 1
  }
  if (seeded > 0) console.log(`[install-config] 已播种 ${seeded} 个模块状态 (force=${force})`)
}

/**
 * 启动入口：在 initEnabledModules() 与首次读取设置之前调用。
 * 便携版跳过。
 */
export function seedFromInstallConfig(): void {
  if (isPortableMode()) return
  try {
    const meta = getAppSettingsTable()
    // 迁移：旧「一次性消费」标记 → 视为已应用当前配置（避免升级后强制重播）
    if (meta.get(LEGACY_APPLIED_FLAG_KEY) === '1') {
      meta.delete(LEGACY_APPLIED_FLAG_KEY)
      const current = getInstallConfigHash()
      if (current && !meta.get(APPLIED_HASH_KEY)) {
        meta.set(APPLIED_HASH_KEY, current)
      }
    }

    const loaded = readInstallConfigRaw()
    if (!loaded) return
    const appliedHash = meta.get(APPLIED_HASH_KEY)
    if (appliedHash === loaded.hash) return // 同一配置已应用过

    const isFirst = !appliedHash
    seedModuleStates(loaded.cfg.modules ?? {}, !isFirst)
    applyInstallConfigOptions(loaded.cfg.options ?? {})
    meta.set(APPLIED_HASH_KEY, loaded.hash)
    console.log('[install-config] 安装期配置已应用 hash=', loaded.hash.slice(0, 12), 'reseed=', !isFirst)
  } catch (err) {
    console.warn('[install-config] 播种失败:', err)
  }
}

/**
 * 数据导入成功后调用：把当前 install-config 哈希写入已恢复的 settings.db，
 * 使下次启动不再用安装配置覆盖导入结果。
 */
export function stampInstallConfigHashAfterImport(): void {
  try {
    if (isPortableMode()) return
    const hash = getInstallConfigHash()
    const meta = getAppSettingsTable()
    if (hash) meta.set(APPLIED_HASH_KEY, hash)
    else meta.delete(APPLIED_HASH_KEY)
    meta.delete(LEGACY_APPLIED_FLAG_KEY)
  } catch (err) {
    console.warn('[install-config] 导入后写入哈希失败:', err)
  }
}
