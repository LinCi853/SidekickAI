// preset-store.ts — 设备预设持久化存储 + IPC 注册
//
// 使用 electron-store 将设备预设持久化到磁盘（presets.json）。
// 首次启动自动填充预置预设（5 个内置设备配置）。
// 与 block-rules-store.ts 模式一致。

import Store from 'electron-store'
import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import type { DevicePreset } from '../shared/types.js'
import { IPC_CHANNELS } from '../shared/types.js'
import { getStoreCwd } from './store-paths.js'
import { DEFAULT_PRESETS, PRESETS_DEFAULT_VERSION } from './presets-default.js'

// 持久化存储实例（写入 presets.json）
const store = new Store<{ presets: DevicePreset[]; version: number }>({
  name: 'presets',
  cwd: getStoreCwd(),
  defaults: { presets: [], version: PRESETS_DEFAULT_VERSION },
})

/**
 * 设备预设存储：CRUD 操作
 */
export class PresetStore {
  /** 读取全部预设 */
  list(): DevicePreset[] {
    return store.get('presets')
  }

  /** 按 id 查找单个预设 */
  get(id: string): DevicePreset | null {
    return store.get('presets').find((p) => p.id === id) ?? null
  }

  /** 新增或更新预设（upsert 语义） */
  save(preset: DevicePreset): DevicePreset {
    const presets = store.get('presets')
    const idx = presets.findIndex((p) => p.id === preset.id)
    if (idx === -1) {
      const created: DevicePreset = {
        ...preset,
        id: preset.id || randomUUID(),
      }
      presets.push(created)
      store.set('presets', presets)
      return created
    }
    presets[idx] = { ...preset, id: presets[idx].id }
    store.set('presets', presets)
    return presets[idx]
  }

  /** 删除预设（内置预设不可删除） */
  delete(id: string): void {
    const presets = store.get('presets')
    const preset = presets.find((p) => p.id === id)
    if (preset?.builtin) {
      console.warn('[preset-store] 内置预设不可删除:', id)
      return
    }
    store.set('presets', presets.filter((p) => p.id !== id))
  }

  /** 更新预设（部分字段） */
  update(id: string, patch: Partial<DevicePreset>): DevicePreset | null {
    const presets = store.get('presets')
    const idx = presets.findIndex((p) => p.id === id)
    if (idx === -1) return null
    presets[idx] = { ...presets[idx], ...patch, id }
    store.set('presets', presets)
    return presets[idx]
  }
}

// 单例实例
export const presetStore = new PresetStore()

/**
 * 根据 id 查找预设（优先从持久化 store 读取，store 未初始化时回退到硬编码 DEFAULT_PRESETS）
 */
export function getPreset(id: string): DevicePreset | null {
  return presetStore.get(id) ?? DEFAULT_PRESETS.find((p) => p.id === id) ?? null
}

/**
 * 注册设备预设 CRUD IPC 处理器
 * 注意：仅注册 SAVE/DELETE/UPDATE，LIST/GET 仍由 settings-ipc.ts 注册
 * （保持向后兼容，避免重复注册 handler 报错）。
 */
export function registerPresetsIPC(): void {
  const ipc = IPC_CHANNELS
  ipcMain.handle(ipc.PRESETS_SAVE, (_e, preset: DevicePreset) =>
    presetStore.save(preset),
  )
  ipcMain.handle(ipc.PRESETS_DELETE, (_e, id: string) =>
    presetStore.delete(id),
  )
  ipcMain.handle(ipc.PRESETS_UPDATE, (_e, id: string, patch: Partial<DevicePreset>) =>
    presetStore.update(id, patch),
  )
}

/**
 * 首次启动自动填充预置设备预设
 * 仅在 store 中预设为空时填充。
 * 版本升级时新增的内置预设自动补充（按 id 匹配，已存在则跳过）。
 */
export function ensureDefaultPresets(): void {
  const existing = store.get('presets')
  if (existing.length === 0) {
    // 首次启动：填充全部预置预设
    for (const preset of DEFAULT_PRESETS) {
      presetStore.save(preset)
    }
    console.log(`[preset-store] 首次启动：填充 ${DEFAULT_PRESETS.length} 个预置设备预设`)
    return
  }

  // 已有预设：补充版本升级时新增的内置预设（按 id 匹配，不存在则 push）
  let updated = 0
  for (const defPreset of DEFAULT_PRESETS) {
    const idx = existing.findIndex((p) => p.id === defPreset.id)
    if (idx === -1) {
      existing.push(defPreset)
      updated++
    }
  }
  if (updated > 0) {
    store.set('presets', existing)
    console.log(`[preset-store] 补充 ${updated} 个新增内置预设`)
  }
}
