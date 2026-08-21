// electron/store/profile-store.ts — Profile 持久化存储 + IPC 注册
//
// 持久化到 SQLite settings.db（profiles 表，createSqliteJsonStore）。
// 每个 Profile 是一个完整的「虚拟浏览器身份」，包含 UA / 指纹 / 窗口配置。
// 通过 ipcMain.handle 暴露 CRUD 接口给渲染进程。

import { ipcMain, session } from 'electron'
import { randomUUID } from 'crypto'
import type { Profile } from '../shared/types.js'
import { IPC_CHANNELS } from '../shared/types.js'
import { broadcastToAllWindows } from '../shared/broadcast.js'
import { generateUniqueName } from '../shared/naming.js'
import { getDefaultProfileParams, createDefaultProfileParams } from './default-config.js'
import { getPreset } from './preset-store.js'
import { createSqliteJsonStore } from './module-state-store.js'

// Windows Chrome 125 默认 UA 已迁移到 default-config.ts

// 持久化存储实例（写入 profiles.json）
// 开发环境：写入项目内 .app-data/ 目录，规避 TRAE 沙箱对 AppData\Roaming 的写入限制
// 生产环境：使用默认 userData 路径（AppData\Roaming\<appName>）
const store = createSqliteJsonStore<{ profiles: Profile[]; version: number }>({
  tableName: 'profiles',
  defaults: { profiles: [], version: 1 },
})

/**
 * 创建默认 Profile
 * 使用 default-config.ts 统一管理的默认参数。
 * id 与时间戳由 create() 重新生成（不接受外部传入）。
 */
function createDefaultProfile(): Profile {
  const params = createDefaultProfileParams()
  return {
    ...params,
    id: randomUUID(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/**
 * Profile 持久化存储：CRUD 操作 + 持久化到 electron-store
 */
export class ProfileStore {
  /** 读取全部 Profile */
  list(): Profile[] {
    return store.get('profiles')
  }

  /** 按 id 查找单个 Profile */
  get(id: string): Profile | null {
    return (store.get('profiles') as Profile[]).find((p) => p.id === id) ?? null
  }

  /**
   * 创建新 Profile
   * 生成 UUID / 时间戳 / 默认指纹配置，合并外部传入字段后持久化。
   * 嵌套对象（viewport / fingerprint）深合并，避免被整体覆盖。
   * order 字段若未指定，自动设为 profiles.length（追加到末尾）。
   */
  create(partial: Partial<Profile>): Profile {
    const defaults = createDefaultProfile()
    const profiles = store.get('profiles')
    const profile: Profile = {
      ...defaults,
      ...partial,
      // id 与时间戳始终新生成，不接受外部传入
      id: randomUUID(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      // 若未指定 order，自动追加到末尾（避免多个 Profile 共用 order=0）
      order: partial.order ?? profiles.length,
      // 深合并嵌套对象
      viewport: { ...defaults.viewport, ...(partial.viewport ?? {}) },
      fingerprint: { ...defaults.fingerprint, ...(partial.fingerprint ?? {}) },
    }

    profiles.push(profile)
    store.set('profiles', profiles)
    return profile
  }

  /**
   * 更新 Profile（合并 patch，更新 updatedAt）
   * id / createdAt 不可变。嵌套对象深合并。
   */
  update(id: string, patch: Partial<Profile>): Profile {
    const profiles = store.get('profiles') as Profile[]
    const idx = profiles.findIndex((p) => p.id === id)
    if (idx === -1) {
      throw new Error(`Profile 不存在: ${id}`)
    }

    const current = profiles[idx]
    const updated: Profile = {
      ...current,
      ...patch,
      id: current.id, // 不允许修改 id
      createdAt: current.createdAt, // 不允许修改创建时间
      updatedAt: Date.now(),
      viewport: { ...current.viewport, ...(patch.viewport ?? {}) },
      fingerprint: { ...current.fingerprint, ...(patch.fingerprint ?? {}) },
      // proxyConfig 深合并：支持局部更新（如仅修改 proxyMode），未传时保留原值
      proxyConfig: patch.proxyConfig
        ? { ...(current.proxyConfig ?? {}), ...patch.proxyConfig }
        : current.proxyConfig,
    }

    profiles[idx] = updated
    store.set('profiles', profiles)
    return updated
  }

  /** 删除 Profile */
  delete(id: string): void {
    const profiles = store.get('profiles') as Profile[]
    // v0.0.9: 禁止删除保底内置应用
    const target = profiles.find((p) => p.id === id)
    if (target?.isBuiltIn) {
      console.warn('[profile-store] 禁止删除保底内置应用:', target.name)
      return
    }
    store.set(
      'profiles',
      profiles.filter((p) => p.id !== id),
    )
  }

  /**
   * 复制 Profile
   * 生成新 id，名称通过 generateUniqueName 保证唯一（不再固定 " (副本)" 后缀），
   * 重置时间戳，order 追加到末尾。深拷贝嵌套对象避免引用共享。
   */
  duplicate(id: string): Profile {
    const source = this.get(id)
    if (!source) {
      throw new Error(`Profile 不存在: ${id}`)
    }

    const profiles = store.get('profiles') as Profile[]
    const existingNames = profiles.map((p) => p.name)
    const now = Date.now()
    const copy: Profile = {
      ...source,
      id: randomUUID(),
      name: generateUniqueName(source.name, existingNames),
      createdAt: now,
      updatedAt: now,
      order: profiles.length, // 追加到末尾
      viewport: { ...source.viewport },
      fingerprint: { ...source.fingerprint },
    }

    profiles.push(copy)
    store.set('profiles', profiles)
    return copy
  }

  /**
   * 基于内置 AI 平台创建新 Profile（"新建 AI 应用"功能）。
   * 从平台预设填充 aiPlatformId/aiPlatformUrl/主题色等字段，
   * 使用 iPhone 15 Pro 移动端预设作为默认设备配置。
   * 名称通过 generateUniqueName 保证唯一（除非显式传入 customName）。
   */
  createAIAppFromPlatform(platformId: string, customName?: string): Profile {
    const platform = AI_PLATFORMS.find((p) => p.id === platformId)
    if (!platform) {
      throw new Error(`找不到 AI 平台: ${platformId}`)
    }
    const iphonePreset = getPreset('iphone-15-pro-safari')
    if (!iphonePreset) {
      throw new Error('找不到 iphone-15-pro-safari 预设')
    }
    const profiles = store.get('profiles') as Profile[]
    const existingNames = profiles.map((p) => p.name)
    const name = customName ?? generateUniqueName(platform.name, existingNames)
    return this.create({
      name,
      devicePreset: platform.defaultMobilePreset,
      userAgent: platform.defaultUA,
      platform: 'mobile',
      viewport: {
        width: iphonePreset.viewport.width,
        height: iphonePreset.viewport.height,
      },
      devicePixelRatio: iphonePreset.devicePixelRatio,
      language: iphonePreset.language,
      timezone: iphonePreset.timezone,
      isAIPlatform: true,
      aiPlatformUrl: platform.url,
      aiPlatformId: platform.id,
      aiPlatformRegion: platform.region,
      aiDesktopPreset: platform.defaultDesktopPreset,
      aiMobilePreset: platform.defaultMobilePreset,
      aiThemeColor: platform.themeColor,
      width: iphonePreset.viewport.width,
      height: iphonePreset.viewport.height,
      fingerprint: {
        seed: Math.floor(Math.random() * 0xffffffff),
        canvas: 'noise',
        webgl: 'noise',
        audio: 'noise',
        fonts: 'noise',
        webrtc: 'real',
      },
    })
  }

  /**
   * 按 orderedIds 顺序重新设置 Profile 的 order 字段。
   * 不在列表中的 Profile 保持原 order。用于拖拽排序。
   */
  reorderProfiles(orderedIds: string[]): void {
    const profiles = store.get('profiles')
    const idToNewOrder = new Map<string, number>()
    orderedIds.forEach((id, index) => idToNewOrder.set(id, index))
    let changed = false
    const now = Date.now()
    for (const profile of profiles) {
      const newOrder = idToNewOrder.get(profile.id)
      if (newOrder !== undefined && profile.order !== newOrder) {
        profile.order = newOrder
        profile.updatedAt = now
        changed = true
      }
    }
    if (changed) {
      store.set('profiles', profiles)
    }
  }
}

// 单例实例（供 WindowManager / IPC 共用）
export const profileStore = new ProfileStore()

/**
 * 注册 Profile CRUD IPC 处理器
 * 在 app.whenReady() 后调用。
 */
export function registerProfileIPC(): void {
  const ipc = IPC_CHANNELS
  ipcMain.handle(ipc.PROFILE_LIST, () => profileStore.list())
  ipcMain.handle(ipc.PROFILE_CREATE, async (_e, partial: Partial<Profile>) => {
    const profile = profileStore.create(partial)
    // 为新 profile 的 partition 挂载 will-download 监听（与 main.ts 启动时批量挂载保持一致）
    try {
      const { attachDownloadHandler } = await import('../utils/download-handler.js')
      attachDownloadHandler(session.fromPartition(`persist:${profile.id}`), profile.id)
    } catch (err) {
      console.warn('[profile-store] 新 profile 挂载下载监听失败:', err)
    }
    // 广播到所有窗口：跨窗口同步 Profile 新建
    broadcastToAllWindows(ipc.PROFILE_CREATED, profile, 'profile')
    return profile
  })
  ipcMain.handle(ipc.PROFILE_UPDATE, async (_e, id: string, patch: Partial<Profile>) => {
    const updated = await profileStore.update(id, patch)
    // 广播到所有窗口：跨窗口同步 Profile 字段（如 name 变更后 AiAppEditor 刷新）
    broadcastToAllWindows(ipc.PROFILE_UPDATED, { id, profile: updated }, 'profile')
    return updated
  })
  ipcMain.handle(ipc.PROFILE_DELETE, async (_e, id: string) => {
    // 1. 关闭可能打开的 BrowserWindow（动态 import 避免循环依赖）
    try {
      const { windowState } = await import('../window-state.js')
      await windowState.windowManager?.closeProfile(id)
    } catch (err) {
      console.warn('[profile-store] 关闭 Profile 窗口失败:', err)
    }
    // 2. 清理 session partition（cookies / storage / cache / auth，删除登录痕迹）
    try {
      const ses = session.fromPartition(`persist:${id}`)
      await ses.clearStorageData()
      await ses.clearCache()
      await ses.clearAuthCache()
    } catch (err) {
      console.warn('[profile-store] 清理 session partition 失败:', err)
    }
    // 3. 删除 store 数据
    profileStore.delete(id)
    // 4. 广播到所有窗口：跨窗口同步 Profile 删除
    broadcastToAllWindows(ipc.PROFILE_DELETED, id, 'profile')
  })
  ipcMain.handle(ipc.PROFILE_DUPLICATE, async (_e, id: string) => {
    const profile = profileStore.duplicate(id)
    // 广播到所有窗口：复制视为新建，触发 PROFILE_CREATED 同步
    broadcastToAllWindows(ipc.PROFILE_CREATED, profile, 'profile')
    return profile
  })
  ipcMain.handle(ipc.PROFILE_REORDER, async (_e, orderedIds: string[]) => {
    profileStore.reorderProfiles(orderedIds)
    // 广播到所有窗口：跨窗口同步 Profile 排序
    broadcastToAllWindows(ipc.PROFILE_REORDERED, orderedIds, 'profile')
    return true
  })
}

/**
 * 首次启动自动创建 9 个 AI 平台 Profile（移动端指纹）
 *
 * 仅在 store 中 profiles 为空时创建。每个平台使用 iPhone 15 Pro 移动端指纹，
 * DeepSeek 为默认平台。使用 default-config.ts 统一管理的默认配置。
 *
 * @returns 创建的 Profile 列表（若已存在 Profile 则返回空数组）
 */
export function ensureDefaultProfiles(): Profile[] {
  const existing = store.get('profiles')
  if (existing.length > 0) {
    return []
  }

  const created: Profile[] = []
  try {
    const defaultParams = getDefaultProfileParams()
    for (const params of defaultParams) {
      const profile = profileStore.create(params)
      created.push(profile)
    }
    console.log(
      `[profile-store] 首次启动：自动创建 ${created.length} 个 AI 平台 Profile（移动端指纹）`,
    )
  } catch (err) {
    console.error('[profile-store] 创建默认 Profile 失败:', err)
  }
  return created
}


