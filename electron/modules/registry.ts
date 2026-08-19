// electron/modules/registry.ts — 模块注册表（模块管理核心框架）
//
// 统一入口 registerModule(manifest)。主进程启动时 initEnabledModules() 按数据库
// 状态决定是否调用 manifest.init；运行期 setModuleEnabled() 触发 init/teardown；
// clearModuleData() 触发清除数据。任何状态变更都广播 MODULE_STATE_CHANGED。
//
// 遵循方案文档第 11 章《模块实现统一设计规范》：
//   - 声明式：init/teardown 成对，teardown 逆序撤销
//   - 启动即隔离：状态入库，重启后从未注册、从未挂载（11.10）
//   - 关闭零残留：禁用后 IPC/热键/窗口/入口全部卸载

import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../shared/types.js'
import type { ModuleInfo, ModuleManifest } from '../shared/types.js'
import { broadcastToAllWindows } from '../shared/broadcast.js'
import {
  getModuleState,
  isLargeModuleInstalledByManifestFile,
  saveModuleState,
  type ModuleStateRecord,
} from '../store/module-state-store.js'
import { getHotkeyManagerInstance } from '../hotkey/manager.js'
import { syncAdvancedPanelHotkey, syncBrowserProfileShortcuts } from './wiring/hotkey-sync.js'
import { injectionBroker } from './injection-broker.js'
import { targetRegistry } from './target-registry.js'

/** 注册表：id → manifest */
const manifests = new Map<string, ModuleManifest>()
/** 运行时状态：id → { enabled, installed }（bootstrap 后与数据库一致） */
const runtime = new Map<string, { enabled: boolean; installed: boolean }>()

/** 注册模块（重复注册直接抛错，保证 manifest 唯一） */
export function registerModule(manifest: ModuleManifest): void {
  if (manifests.has(manifest.id)) {
    throw new Error(`[modules] 模块重复注册: ${manifest.id}`)
  }
  manifests.set(manifest.id, manifest)
}

export function getManifest(id: string): ModuleManifest | undefined {
  return manifests.get(id)
}

export function listManifests(): ModuleManifest[] {
  return [...manifests.values()]
}

/** 查询模块运行时启用状态（未注册的 id 一律视为禁用） */
export function isModuleEnabled(id: string): boolean {
  return runtime.get(id)?.enabled ?? false
}

/** 查询模块运行时安装状态（未注册的 id 一律视为未安装） */
export function isModuleInstalled(id: string): boolean {
  return runtime.get(id)?.installed ?? false
}

/**
 * 断言模块已启用；禁用时抛出错误（窗口创建/入口拦截统一使用，
 * 见 11.10「全路径封死」）。
 */
export function assertModuleEnabled(id: string, actionLabel?: string): void {
  if (!isModuleEnabled(id)) {
    const label = actionLabel ? `（${actionLabel}）` : ''
    throw new Error(`[modules] 模块已关闭: ${id}${label}`)
  }
}

/** 模块专属窗口路由标记（残留扫描用） */
const MODULE_WINDOW_MARKERS: Record<string, string[]> = {
  'custom-chat': ['mode=chat'],
  'prompt-library': ['mode=prompts'],
  browser: ['mode=browser', 'mode=history-download'],
  voice: ['mode=record-indicator'],
}

export interface ResidualScanResult {
  ok: boolean
  violations: string[]
  disabledModules: string[]
}

/** 模块专属 IPC 通道前缀（残留扫描用） */
const MODULE_IPC_PREFIXES: Record<string, string[]> = {
  'custom-chat': ['AI_PROVIDER_', 'CHAT_'],
  'prompt-library': ['PROMPT_', 'INJECTION_'],
  voice: ['STT_', 'VOICE_'],
  tts: ['VOICE_TEST_TTS'],
  browser: ['BROWSER_', 'NAV_HISTORY_', 'BOOKMARK_', 'CURSOR_'],
  freeze: ['FREEZE_'],
  whiteboard: ['WHITEBOARD_'],
  notes: ['NOTES_'],
}

/**
 * 零残留扫描（11.8/11.10 验收门禁）：检查禁用模块是否仍有
 * 专属窗口/热键残留。窗口级可查（URL 路由标记），热键级检查语音热键。
 *
 * Phase 6 扩展：增加 InjectionBroker、TargetRegistry 和 IPC handler 的残留检查。
 */
export function runResidualScan(): ResidualScanResult {
  const violations: string[] = []
  const disabled = listModuleInfos()
    .filter((m) => !m.enabled)
    .map((m) => m.id)
  // 1. 窗口扫描
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    let url = ''
    try {
      url = win.webContents.getURL()
    } catch {
      continue
    }
    for (const [modId, markers] of Object.entries(MODULE_WINDOW_MARKERS)) {
      if (isModuleEnabled(modId)) continue
      if (markers.some((mk) => url.includes(mk))) {
        violations.push('模块 ' + modId + ' 已关闭但仍存在窗口: ' + url)
      }
    }
  }
  // 2. 热键扫描：语音模块关闭时不应有语音热键注册
  const hm = getHotkeyManagerInstance()
  if (hm && !isModuleEnabled('voice') && hm.voiceUnregisterFn) {
    violations.push('语音模块已关闭但仍注册了 Alt+V 语音热键')
  }
  // 3. InjectionBroker 扫描：禁用模块不应有活跃注入
  try {
    for (const moduleId of disabled) {
      const count = injectionBroker.getModuleInjectionCount(moduleId)
      if (count > 0) {
        violations.push(`模块 ${moduleId} 已关闭但仍有 ${count} 个活跃注入`)
      }
    }
  } catch {
    // InjectionBroker 可能尚未初始化（启动早期阶段），忽略
  }
  // 4. TargetRegistry 扫描：禁用模块不应有活跃目标
  try {
    for (const moduleId of disabled) {
      const targets = targetRegistry.getByOwner(moduleId)
      const active = targets.filter((t) => t.state === 'active')
      if (active.length > 0) {
        violations.push(`模块 ${moduleId} 已关闭但仍有 ${active.length} 个活跃目标: ${active.map((t) => t.targetId).join(', ')}`)
      }
    }
  } catch {
    // TargetRegistry 可能尚未初始化，忽略
  }
  // 5. IPC handler 扫描：禁用模块不应有注册的 IPC handler
  try {
    const { ipcMain } = require('electron')
    const registeredChannels = ipcMain.eventNames()
    for (const moduleId of disabled) {
      const prefixes = MODULE_IPC_PREFIXES[moduleId]
      if (!prefixes) continue
      for (const channel of registeredChannels) {
        const channelStr = String(channel)
        if (prefixes.some((prefix) => channelStr.startsWith(prefix))) {
          violations.push(`模块 ${moduleId} 已关闭但仍注册了 IPC 通道: ${channelStr}`)
        }
      }
    }
  } catch {
    // 忽略检查失败
  }
  const result: ResidualScanResult = { ok: violations.length === 0, violations, disabledModules: disabled }
  console.log('[modules] 残留扫描:', result.ok ? '通过' : '发现残留: ' + violations.join('; '))
  return result
}

/** 渲染层可见的模块信息列表 */
export function listModuleInfos(): ModuleInfo[] {
  return listManifests().map((m) => {
    const rt = runtime.get(m.id) ?? { enabled: false, installed: false }
    return {
      id: m.id,
      name: m.name,
      description: m.description,
      category: m.category,
      sizeLevel: m.sizeLevel,
      testBadge: m.testBadge,
      defaultEnabled: m.defaultEnabled,
      dependencies: [...m.dependencies],
      entries: [...m.entries],
      hotkeys: [...m.hotkeys],
      enabled: rt.enabled,
      installed: rt.installed,
    }
  })
}

/** 广播模块状态到所有窗口 */
function broadcastModuleState(): void {
  broadcastToAllWindows(
    IPC_CHANNELS.MODULE_STATE_CHANGED,
    { modules: listModuleInfos() },
    'modules',
  )
}

/**
 * 启动 bootstrap：补默认状态入库 → 计算运行时状态 → 依次执行已启用模块的 init。
 * 必须在 app.whenReady 后调用（依赖 userData 路径与数据库）。
 * 依赖校验按注册顺序遍历，因此被依赖模块必须先注册（见 manifests.ts 顺序约束）。
 */
export async function initEnabledModules(): Promise<void> {
  for (const m of listManifests()) {
    let st = getModuleState(m.id)
    if (!st) {
      const installed =
        m.sizeLevel === 'large' ? isLargeModuleInstalledByManifestFile(m.id) : true
      st = {
        id: m.id,
        enabled: m.defaultEnabled && installed,
        installed,
        clearedAt: 0,
        updatedAt: Date.now(),
      }
      saveModuleState(st)
    }
    // 大模块：以安装清单为准刷新 installed（补装后自动恢复可启用）
    if (m.sizeLevel === 'large') {
      const installedNow = isLargeModuleInstalledByManifestFile(m.id)
      if (installedNow !== st.installed) {
        st = { ...st, installed: installedNow, enabled: installedNow ? st.enabled : false, updatedAt: Date.now() }
        saveModuleState(st)
      }
    }
    // 硬依赖：依赖模块未启用时级联禁用（11.1 单向依赖）
    let enabled = st.enabled && st.installed
    if (enabled) {
      for (const dep of m.dependencies) {
        const depRt = runtime.get(dep)
        if (!depRt || !depRt.enabled || !depRt.installed) {
          console.warn(`[modules] 模块 ${m.id} 因依赖 ${dep} 未启用而级联禁用`)
          enabled = false
          break
        }
      }
    }
    runtime.set(m.id, { enabled, installed: st.installed })
    if (enabled && m.init) {
      try {
        await m.init()
        console.log(`[modules] 模块已启用: ${m.id}`)
      } catch (err) {
        // 运行期故障：仅本次会话回退为禁用，不持久化（用户选择保持，
        // 修复代码/环境后下次启动自动重试，避免一次故障永久关闭模块）。
        console.error(`[modules] 模块 init 失败，本次会话回退为禁用: ${m.id}`, err)
        runtime.set(m.id, { enabled: false, installed: st.installed })
      }
    }
  }
  const enabledIds = listModuleInfos().filter((x) => x.enabled).map((x) => x.id)
  console.log(`[modules] 模块初始化完成，启用: ${enabledIds.join(', ') || '（无）'}`)
  // 启动即隔离验收：禁用模块零残留
  runResidualScan()
}

/**
 * 运行期启用/禁用模块。启用失败返回错误信息；禁用即使 teardown 抛错也强制置为
 * 禁用（零残留优先），并级联关闭硬依赖本模块的其他模块。
 */
export async function setModuleEnabled(
  id: string,
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const m = manifests.get(id)
  if (!m) return { ok: false, error: `未知模块: ${id}` }
  const rt = runtime.get(id)
  if (!rt) return { ok: false, error: `模块未初始化: ${id}` }
  if (enabled && !rt.installed) {
    return { ok: false, error: '该模块未安装，请重新运行安装包补装' }
  }
  if (enabled) {
    for (const dep of m.dependencies) {
      if (!isModuleEnabled(dep)) {
        return { ok: false, error: `依赖模块未启用: ${getManifest(dep)?.name ?? dep}` }
      }
    }
    if (rt.enabled) return { ok: true }
    try {
      await m.init?.()
      rt.enabled = true
    } catch (err) {
      console.error(`[modules] 启用失败: ${id}`, err)
      return { ok: false, error: String(err) }
    }
  } else {
    if (!rt.enabled) return { ok: true }
    try {
      await m.teardown?.()
    } catch (err) {
      console.error(`[modules] 禁用 teardown 异常（继续强制禁用）: ${id}`, err)
    }
    rt.enabled = false
    // 硬依赖级联：依赖本模块的模块一并关闭（如关闭 custom-chat → 关闭 tts）
    for (const other of listManifests()) {
      if (other.dependencies.includes(id) && runtime.get(other.id)?.enabled) {
        await setModuleEnabled(other.id, false)
      }
    }
    // 零残留自检（11.10）
    runResidualScan()
  }
  const st = getModuleState(id) ?? {
    id,
    enabled: rt.enabled,
    installed: rt.installed,
    clearedAt: 0,
    updatedAt: 0,
  }
  saveModuleState({ ...st, enabled: rt.enabled, updatedAt: Date.now() })
  broadcastModuleState()
  // 模块 → 热键自动同步（Alt+Q 面板可用性 / 每应用浏览器快捷键）
  void syncAdvancedPanelHotkey()
  void syncBrowserProfileShortcuts()
  return { ok: true }
}

/** 清除模块全部用户数据（不可逆；manifest 未实现 clearData 时拒绝） */
export async function clearModuleData(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const m = manifests.get(id)
  if (!m) return { ok: false, error: `未知模块: ${id}` }
  if (!m.clearData) return { ok: false, error: '该模块暂不支持清除数据' }
  try {
    await m.clearData()
    const rt = runtime.get(id)
    saveModuleState({
      id,
      enabled: rt?.enabled ?? false,
      installed: rt?.installed ?? true,
      clearedAt: Date.now(),
      updatedAt: Date.now(),
    })
    broadcastModuleState()
    return { ok: true }
  } catch (err) {
    console.error(`[modules] 清除数据失败: ${id}`, err)
    return { ok: false, error: String(err) }
  }
}

// ==================== 统一注入管线 re-export ====================
// 便利导出，避免调用方直接依赖 modules/feature-gate.ts
export { featureGate } from './feature-gate.js'
export { capabilityRegistry } from './capability-registry.js'
export { injectionBroker } from './injection-broker.js'
export { EffectScope } from './effect-scope.js'
export type { EffectHandle, EffectKind } from './effect-scope.js'
