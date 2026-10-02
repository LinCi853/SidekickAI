import { windowState } from '../window-state.js'
import { isModuleEnabled } from '../modules/registry.js'
import { setAssetNavigation } from '../assets/navigation.js'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import type { AssetNavigation } from '../shared/ai-assets.types.js'
import {
  PROMPT_WINDOW_ID,
  createSingletonPopupWindow,
} from './helpers.js'

/** The legacy search action opens the shared asset window. */
export function showHistoryWindow(): void {
  showPromptWindow({ focusSearch: true })
}

/** Opens the module-owned asset singleton with optional navigation. */
export function showPromptWindow(request: AssetNavigation = {}): void {
  if (!isModuleEnabled('prompt-library')) return
  const navigation = setAssetNavigation(request)
  const win = createSingletonPopupWindow({
    width: 960,
    height: 720,
    minWidth: 360,
    minHeight: 400,
    title: '工百窗 - AI资产',
    windowId: PROMPT_WINDOW_ID,
    mode: 'prompts',
    getExisting: () => windowState.promptWindow,
    setWindow: (win) => { windowState.promptWindow = win },
  })
  win.webContents.send(IPC_CHANNELS.ASSET_NAVIGATION, navigation)
}

/**
 * 创建/显示 AI 应用编辑独立窗口（多例，按 windowKey 单例）。
 * - 编辑模式：windowKey = profileId（精确到实例，支持同一平台多实例）
 * - 新建模式：windowKey = 'create'（同时只能开一个新建窗口）
 * windowId 编码全部 opts（Base64 JSON），供渲染器解析。
 */
export function showAiAppEditorWindow(opts: {
  platformId?: string;
  profileId?: string;
  mode?: 'edit' | 'create';
}): void {
  // 单例 key：编辑模式用 profileId，新建模式固定 'create'
  const windowKey =
    opts.mode === 'create'
      ? 'create'
      : opts.profileId ?? opts.platformId ?? 'default'

  // windowId 编码全部 opts（Base64 JSON），供渲染器解析
  const encodedOpts = Buffer.from(JSON.stringify(opts)).toString('base64')

  createSingletonPopupWindow({
    width: 640,
    height: 720,
    minWidth: 480,
    minHeight: 400,
    title: opts.mode === 'create' ? '工百窗 - 新建 AI 应用' : '工百窗 - AI 应用配置',
    windowId: `ai-app-editor-${encodedOpts}`,
    mode: 'ai-app-editor',
    getExisting: () => windowState.aiAppEditorWindows.get(windowKey),
    setWindow: (win) => {
      if (win) windowState.aiAppEditorWindows.set(windowKey, win)
      else windowState.aiAppEditorWindows.delete(windowKey)
    },
  })
}

/**
 * 创建/显示数据迁移独立窗口（单例）。
 * 提供细粒度导出选项（基础数据 / 登录凭据 / 应用数据 / 离线缓存 / 语音模型）+ 三档预设 + 导入功能。
 * 已存在则聚焦，不重复打开。
 */
export function showDataExportWindow(): void {
  createSingletonPopupWindow({
    width: 600,
    height: 720,
    minWidth: 480,
    minHeight: 560,
    title: '工百窗 - 数据迁移',
    windowId: 'data-export',
    mode: 'data-export',
    getExisting: () => windowState.dataExportWindow,
    setWindow: (win) => { windowState.dataExportWindow = win },
  })
}

/**
 * 创建/显示设置独立窗口（单例）。
 * 左导航+右内容布局，5 类分组：外观与交互、AI服务、网络与隐私、高级、关于。
 * 已存在则聚焦，不重复打开。
 */
export function showSettingsWindow(): void {
  createSingletonPopupWindow({
    width: 760,
    height: 600,
    minWidth: 600,
    minHeight: 480,
    title: '工百窗 - 设置',
    windowId: 'settings',
    mode: 'settings',
    getExisting: () => windowState.settingsWindow,
    setWindow: (win) => { windowState.settingsWindow = win },
  })
}
