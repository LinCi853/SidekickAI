// electron/store/ai-provider-store.ts — 自定义 AI 提供商持久化存储
//
// 使用 electron-store 持久化 Provider 列表到 ai-providers.json。
// API Key 通过应用内 AES-256-GCM 加密后存储（仅加密的 cipher 字符串落盘），
// 读取时解密为明文返回给主进程使用；list 返回给渲染进程时 apiKey 仍为明文
// （渲染进程只用于展示星号，不会回传给第三方）。
//
// 加密密钥存储在 app-key.json，随数据一起跨设备迁移，不依赖 OS 用户凭据。

import { ipcMain, safeStorage, dialog } from 'electron'
import { randomUUID } from 'crypto'
import { writeFileSync, readFileSync } from 'fs'
import type { CustomAIProvider, CustomAIProviderInput } from '../shared/types.js'
import { IPC_CHANNELS } from '../shared/types.js'
import { createJsonStore } from './store-paths.js'
import {
  isSafeStorageAvailable,
  xorDecrypt,
} from '../utils/permission-manager.js'
import { encryptString, decryptString, isAesEncrypted, encryptWithPassword, decryptWithPassword } from '../utils/app-crypto.js'

/** 落盘的 Provider 结构（apiKey 为加密后的 base64 字符串） */
interface PersistedProvider extends Omit<CustomAIProvider, 'apiKey'> {
  /** 加密后的 API Key（base64 字符串） */
  apiKeyCipher: string
}

/**
 * v0.5.2 R-5：从供应商的 chat 端点推导音频端点。
 * - apiEndpoint 含 /chat/completions → 替换为 /audio/{path}
 * - 否则 → 追加 /audio/{path}
 */
export function deriveAudioEndpoint(apiEndpoint: string, path: 'speech' | 'transcriptions'): string {
  if (apiEndpoint.includes('/chat/completions')) {
    return apiEndpoint.replace('/chat/completions', `/audio/${path}`)
  }
  return apiEndpoint.replace(/\/$/, '') + `/audio/${path}`
}

// 持久化存储实例（写入 ai-providers.json）
const store = createJsonStore<{ providers: PersistedProvider[]; version: number }>({
  name: 'ai-providers',
  defaults: { providers: [], version: 1 },
})

/**
 * 加密 API Key。
 * 使用应用内 AES-256-GCM 加密，密钥存储在 app-key.json，可跨设备迁移。
 */
function encryptApiKey(plain: string): string {
  if (!plain) return ''
  return encryptString(plain)
}

/**
 * 解密 API Key。
 * 自动识别多种格式：
 * - `aes:` 前缀：应用内 AES-256-GCM 加密（新方案，推荐）
 * - `xor:` 前缀：历史 XOR 降级加密（兼容旧数据）
 * - `plain:` 前缀：历史明文（兼容旧数据）
 * - 无前缀：历史 safeStorage 密文（兼容旧数据，仅在源设备可解密）
 */
function decryptApiKey(cipher: string): string {
  if (!cipher) return ''
  // 应用内 AES 加密（新方案）
  if (isAesEncrypted(cipher)) {
    return decryptString(cipher)
  }
  // 历史明文兼容
  if (cipher.startsWith('plain:')) {
    console.warn('[ai-provider-store] 检测到历史明文 Key，建议尽快重新保存以加密')
    return cipher.slice(6)
  }
  // XOR 降级密文
  if (cipher.startsWith('xor:')) {
    return xorDecrypt(cipher)
  }
  // 历史 safeStorage 密文（仅源设备可解密，跨设备迁移时会失效）
  if (isSafeStorageAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
    } catch (e) {
      throw new Error(`解密 API Key 失败（safeStorage 密文）: ${(e as Error).message}`)
    }
  }
  throw new Error('无法解密 API Key：safeStorage 不可用且密文非 aes/xor/plain 格式')
}

/** 将落盘结构转换为对外暴露的 Provider（解密 apiKey，解密失败时返回空 key） */
function toProvider(p: PersistedProvider): CustomAIProvider {
  const { apiKeyCipher, ...rest } = p
  let apiKey = ''
  try {
    apiKey = decryptApiKey(apiKeyCipher)
  } catch (e) {
    console.warn('[ai-provider-store] 解密 API Key 失败，返回空 key:', (e as Error).message)
  }
  return {
    ...rest,
    apiKey,
  }
}

/** 将输入转换为落盘结构（加密 apiKey） */
function toPersisted(input: CustomAIProviderInput, id: string, now: number): PersistedProvider {
  return {
    id,
    name: input.name,
    protocol: input.protocol,
    apiEndpoint: input.apiEndpoint,
    apiKeyCipher: encryptApiKey(input.apiKey),
    model: input.model,
    // v0.5.2 regress-1：备选模型列表（同供应商下可切换使用的多个模型）
    alternativeModels: input.alternativeModels,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    createdAt: now,
    updatedAt: now,
    // 新建 Provider 尚未被使用，lastUsedAt 为 null（AppSwitcher 排序时落在最后）
    lastUsedAt: null,
    // v0.5.2 R-5：TTS/STT per-provider 配置
    ttsEnabled: input.ttsEnabled,
    ttsModel: input.ttsModel,
    sttEnabled: input.sttEnabled,
    sttModel: input.sttModel,
  }
}

/**
 * 自定义 AI 提供商持久化存储：CRUD + 连通性测试入口
 */
export class AIProviderStore {
  /** 列出全部 Provider（解密 apiKey） */
  list(): CustomAIProvider[] {
    return store.get('providers').map(toProvider)
  }

  /** 按 id 查找单个 Provider */
  get(id: string): CustomAIProvider | null {
    const p = store.get('providers').find((x) => x.id === id)
    return p ? toProvider(p) : null
  }

  /** 创建 Provider */
  create(input: CustomAIProviderInput): CustomAIProvider {
    const now = Date.now()
    const id = randomUUID()
    const persisted = toPersisted(input, id, now)
    const providers = store.get('providers')
    providers.push(persisted)
    store.set('providers', providers)
    return toProvider(persisted)
  }

  /** 更新 Provider（合并 patch） */
  update(id: string, patch: Partial<CustomAIProviderInput>): CustomAIProvider {
    const providers = store.get('providers')
    const idx = providers.findIndex((x) => x.id === id)
    if (idx === -1) {
      throw new Error(`AI Provider 不存在: ${id}`)
    }
    const current = providers[idx]
    const updated: PersistedProvider = {
      ...current,
      name: patch.name ?? current.name,
      protocol: patch.protocol ?? current.protocol,
      apiEndpoint: patch.apiEndpoint ?? current.apiEndpoint,
      model: patch.model ?? current.model,
      // v0.5.2 regress-1：备选模型列表（patch 显式提供则覆盖，含空数组；undefined 保留 current）
      alternativeModels: patch.alternativeModels ?? current.alternativeModels,
      temperature: patch.temperature ?? current.temperature,
      maxTokens: patch.maxTokens ?? current.maxTokens,
      // v0.5.2 regress-4：仅在 patch 显式提供非空 apiKey 时才更新（避免误清空）
      apiKeyCipher:
        patch.apiKey !== undefined && patch.apiKey !== '' ? encryptApiKey(patch.apiKey) : current.apiKeyCipher,
      // v0.5.2 R-5：TTS/STT per-provider 配置
      ttsEnabled: patch.ttsEnabled ?? current.ttsEnabled,
      ttsModel: patch.ttsModel ?? current.ttsModel,
      sttEnabled: patch.sttEnabled ?? current.sttEnabled,
      sttModel: patch.sttModel ?? current.sttModel,
      updatedAt: Date.now(),
    }
    providers[idx] = updated
    store.set('providers', providers)
    return toProvider(updated)
  }

  /** 删除 Provider */
  delete(id: string): void {
    const providers = store.get('providers')
    store.set(
      'providers',
      providers.filter((x) => x.id !== id),
    )
  }

  /**
   * 更新 Provider 的最近使用时间戳为当前时间。
   * 由 AppSwitcher 打开自定义 AI / 显示 chat 脱离窗口时调用，
   * 供 AppSwitcher 按 lastUsedAt 降序排列。
   */
  touchLastUsed(id: string): void {
    const providers = store.get('providers')
    const idx = providers.findIndex((x) => x.id === id)
    if (idx === -1) return
    providers[idx] = { ...providers[idx], lastUsedAt: Date.now() }
    store.set('providers', providers)
  }

  /**
   * 需求 9：加密导出 Provider 配置（API Key 明文包含在加密串内）。
   * 用于跨设备/跨用户迁移站点信息。
   * @param password 加密密码
   * @param selectedIds 可选：选择性导出的 provider id 列表（不传或为空则导出全部）
   * @returns 加密字符串（pw: 前缀）
   */
  exportEncrypted(password: string, selectedIds?: string[]): string {
    const all = store.get('providers')
    const targets = selectedIds && selectedIds.length > 0
      ? all.filter((p) => selectedIds.includes(p.id))
      : all
    const providers = targets.map((p) => {
      // 解密 apiKey 为明文，再加密到密码串中
      let apiKeyPlain = ''
      try {
        apiKeyPlain = decryptApiKey(p.apiKeyCipher)
      } catch {
        console.warn(`[ai-provider-store] 导出时解密失败，apiKey 将为空: ${p.name}`)
      }
      return {
        id: p.id,
        name: p.name,
        protocol: p.protocol,
        apiEndpoint: p.apiEndpoint,
        apiKey: apiKeyPlain,
        model: p.model,
        alternativeModels: p.alternativeModels,
        temperature: p.temperature,
        maxTokens: p.maxTokens,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        lastUsedAt: p.lastUsedAt,
        // v0.5.2 R-5：TTS/STT per-provider 配置
        ttsEnabled: p.ttsEnabled,
        ttsModel: p.ttsModel,
        sttEnabled: p.sttEnabled,
        sttModel: p.sttModel,
      }
    })
    const payload = JSON.stringify({ version: 1, providers, exportedAt: Date.now() })
    return encryptWithPassword(payload, password)
  }

  /**
   * 需求 9：从加密串导入 Provider 配置（覆盖现有同 id 的 Provider）。
   * @param encrypted 加密字符串（pw: 前缀）
   * @param password 解密密码
   * @returns { ok, error? }
   */
  importEncrypted(encrypted: string, password: string): { ok: boolean; error?: string } {
    try {
      const json = decryptWithPassword(encrypted, password)
      const parsed = JSON.parse(json) as {
        version?: number
        providers?: Array<{
          id?: string
          name?: string
          protocol?: string
          apiEndpoint?: string
          apiKey?: string
          model?: string
          alternativeModels?: string[]
          temperature?: number
          maxTokens?: number
          ttsEnabled?: boolean
          ttsModel?: string
          sttEnabled?: boolean
          sttModel?: string
        }>
      }
      if (!parsed.providers || !Array.isArray(parsed.providers)) {
        return { ok: false, error: '导入文件格式异常：缺少 providers 数组' }
      }

      const existing = store.get('providers')
      for (const imp of parsed.providers) {
        if (!imp.id || !imp.name || !imp.apiEndpoint) continue
        const idx = existing.findIndex((x) => x.id === imp.id)
        const persisted: PersistedProvider = {
          id: imp.id,
          name: imp.name,
          protocol: (imp.protocol as 'openai' | 'anthropic' | 'custom') || 'openai',
          apiEndpoint: imp.apiEndpoint,
          apiKeyCipher: encryptApiKey(imp.apiKey || ''),
          model: imp.model || '',
          alternativeModels: imp.alternativeModels,
          temperature: imp.temperature,
          maxTokens: imp.maxTokens,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lastUsedAt: null,
          ttsEnabled: imp.ttsEnabled,
          ttsModel: imp.ttsModel,
          sttEnabled: imp.sttEnabled,
          sttModel: imp.sttModel,
        }
        if (idx === -1) existing.push(persisted)
        else existing[idx] = persisted
      }
      store.set('providers', existing)
      console.log(`[ai-provider-store] 导入 ${parsed.providers.length} 个 Provider`)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /**
   * v0.5.2 B-4：预览导入（dry-run）。
   * 解密加密串并返回 provider 列表 + 与现有 provider 的 id 冲突列表，**不持久化**。
   * 渲染层可基于此显示导入预览（哪些是新增、哪些是覆盖）。
   */
  previewImport(encrypted: string, password: string): {
    ok: boolean
    error?: string
    providers?: Array<{
      id: string
      name: string
      protocol: string
      apiEndpoint: string
      model: string
      alternativeModels?: string[]
      ttsEnabled?: boolean
      ttsModel?: string
      sttEnabled?: boolean
      sttModel?: string
    }>
    conflictIds?: string[]
  } {
    try {
      const json = decryptWithPassword(encrypted, password)
      const parsed = JSON.parse(json) as {
        version?: number
        providers?: Array<{
          id?: string
          name?: string
          protocol?: string
          apiEndpoint?: string
          apiKey?: string
          model?: string
          alternativeModels?: string[]
          ttsEnabled?: boolean
          ttsModel?: string
          sttEnabled?: boolean
          sttModel?: string
        }>
      }
      if (!parsed.providers || !Array.isArray(parsed.providers)) {
        return { ok: false, error: '导入文件格式异常：缺少 providers 数组' }
      }
      const existing = store.get('providers')
      const existingIds = new Set(existing.map((p) => p.id))
      const providers = parsed.providers
        .filter((p) => p.id && p.name && p.apiEndpoint)
        .map((p) => ({
          id: p.id as string,
          name: p.name as string,
          protocol: p.protocol || 'openai',
          apiEndpoint: p.apiEndpoint as string,
          model: p.model || '',
          alternativeModels: p.alternativeModels,
          ttsEnabled: p.ttsEnabled,
          ttsModel: p.ttsModel,
          sttEnabled: p.sttEnabled,
          sttModel: p.sttModel,
        }))
      const conflictIds = providers.map((p) => p.id).filter((id) => existingIds.has(id))
      return { ok: true, providers, conflictIds }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
}

// 单例实例
export const aiProviderStore = new AIProviderStore()

/**
 * 校验已有 Provider 的密文可解密性，并将旧格式密文（safeStorage/XOR/plain）迁移为应用内 AES 加密。
 * - safeStorage 密文：在源设备可解密，解密后用新方案重新加密；跨设备时解密失败则清空
 * - XOR/plain 密文：始终可解密，解密后用新方案重新加密
 * - AES 密文：已是新格式，无需处理
 */
export function ensureDefaultProviders(): void {
  const providers = store.get('providers')
  if (providers.length === 0) return
  let mutated = false
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i]
    if (!p.apiKeyCipher) continue
    // 已是 AES 格式，跳过
    if (isAesEncrypted(p.apiKeyCipher)) continue
    try {
      // 旧格式：尝试解密为明文，然后用新方案重新加密
      const plain = decryptApiKey(p.apiKeyCipher)
      providers[i] = { ...p, apiKeyCipher: encryptString(plain) }
      console.log(`[ai-provider-store] Provider ${p.name} 密文已迁移为应用内 AES 加密`)
      mutated = true
    } catch {
      // 解密失败（通常是 safeStorage 密文跨设备失效）：清空密文
      providers[i] = { ...p, apiKeyCipher: '' }
      console.warn(`[ai-provider-store] Provider ${p.name} 密文失效，已清空（需用户重新输入 API Key）`)
      mutated = true
    }
  }
  if (mutated) store.set('providers', providers)
}

/**
 * 注册 AI Provider CRUD IPC 处理器
 * 必须在 app.whenReady() 后调用（safeStorage 依赖）。
 * 注意：AI_PROVIDER_TEST / AI_PROVIDER_LIST_MODELS 在 ai/handler.ts 中注册（需要调用 API 客户端）。
 */
export function registerAIProviderIPC(): void {
  const ipc = IPC_CHANNELS
  ipcMain.handle(ipc.AI_PROVIDER_LIST, () => aiProviderStore.list())
  ipcMain.handle(ipc.AI_PROVIDER_CREATE, (_e, input: CustomAIProviderInput) =>
    aiProviderStore.create(input),
  )
  ipcMain.handle(
    ipc.AI_PROVIDER_UPDATE,
    (_e, id: string, patch: Partial<CustomAIProviderInput>) =>
      aiProviderStore.update(id, patch),
  )
  ipcMain.handle(ipc.AI_PROVIDER_DELETE, (_e, id: string) => aiProviderStore.delete(id))
  // 需求 9：加密导出 / 导入（v0.5.2 regress-3：支持 selectedIds 选择性导出）
  ipcMain.handle(ipc.AI_PROVIDER_EXPORT_ENCRYPTED, (_e, password: string, selectedIds?: string[]) =>
    aiProviderStore.exportEncrypted(password, selectedIds),
  )
  ipcMain.handle(
    ipc.AI_PROVIDER_IMPORT_ENCRYPTED,
    (_e, encrypted: string, password: string) =>
      aiProviderStore.importEncrypted(encrypted, password),
  )
  // v0.5.2 B-4：预览导入（dry-run，不持久化）
  ipcMain.handle(
    ipc.AI_PROVIDER_PREVIEW_IMPORT,
    (_e, encrypted: string, password: string) =>
      aiProviderStore.previewImport(encrypted, password),
  )
  // v0.5.2 B-4：写入加密导出文件到指定路径（渲染层提供路径 + 内容）
  ipcMain.handle(
    ipc.AI_PROVIDER_WRITE_EXPORT_FILE,
    (_e, filePath: string, content: string) => {
      try {
        writeFileSync(filePath, content, 'utf8')
        return { ok: true }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
  )
  // v0.5.2 B-4：读取导入文件内容（渲染层提供路径）
  ipcMain.handle(
    ipc.AI_PROVIDER_READ_IMPORT_FILE,
    (_e, filePath: string) => {
      try {
        const content = readFileSync(filePath, 'utf8')
        return { ok: true, content }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
  )
  // v0.5.2 B-4：AI Provider 加密导出文件保存对话框
  ipcMain.handle(ipc.AI_PROVIDER_SELECT_EXPORT_PATH, async () => {
    const result = await dialog.showSaveDialog({
      filters: [{ name: 'Sidekick AI Providers', extensions: ['sapp'] }],
      defaultPath: `ai-providers-${new Date().toISOString().slice(0, 10)}.sapp`,
    })
    return result.canceled ? null : result.filePath
  })
  // v0.5.2 B-4：AI Provider 加密导入文件打开对话框
  ipcMain.handle(ipc.AI_PROVIDER_SELECT_IMPORT_FILE, async () => {
    const result = await dialog.showOpenDialog({
      filters: [{ name: 'Sidekick AI Providers', extensions: ['sapp'] }, { name: 'All Files', extensions: ['*'] }],
      properties: ['openFile'],
    })
    return result.canceled ? null : result.filePaths[0]
  })
}
