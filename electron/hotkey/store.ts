// electron/hotkey/store.ts — 热键配置持久化存储（写入 hotkey.json）

import { createSqliteJsonStore } from '../store/module-state-store.js'
import type { HotkeyAction } from './types.js'

export const DEFAULT_HOTKEYS: Record<HotkeyAction, string> = {
  toggleMainWindow: 'Alt+Space',
  toggleDetachedWindows: 'Alt+Q',
  backgroundVoice: 'Alt+V',
  toggleVoice: '',
  toggleAiAssets: '',
}

export const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  toggleMainWindow: '切换主窗口显隐',
  toggleDetachedWindows: '切换脱离窗口显隐',
  backgroundVoice: '后台语音输入（按住）',
  toggleVoice: '语音输入（切换）',
  toggleAiAssets: '打开／关闭 AI资产',
}

type HotkeyStoreSchema = {
  'hotkey.toggleMainWindow': string
  'hotkey.toggleDetachedWindows': string
  'hotkey.backgroundVoice': string
  'hotkey.toggleVoice': string
  'hotkey.toggleAiAssets': string
  'hotkey.enabled.toggleMainWindow': boolean
  'hotkey.enabled.toggleDetachedWindows': boolean
  'hotkey.enabled.backgroundVoice': boolean
  'hotkey.enabled.toggleVoice': boolean
  'hotkey.enabled.toggleAiAssets': boolean
}

export const hotkeyStore = createSqliteJsonStore<HotkeyStoreSchema>({
  tableName: 'hotkey_config',
  defaults: {
    'hotkey.toggleMainWindow': DEFAULT_HOTKEYS.toggleMainWindow,
    'hotkey.toggleDetachedWindows': DEFAULT_HOTKEYS.toggleDetachedWindows,
    'hotkey.backgroundVoice': DEFAULT_HOTKEYS.backgroundVoice,
    'hotkey.toggleVoice': DEFAULT_HOTKEYS.toggleVoice,
    'hotkey.toggleAiAssets': DEFAULT_HOTKEYS.toggleAiAssets,
    'hotkey.enabled.toggleMainWindow': true,
    'hotkey.enabled.toggleDetachedWindows': true,
    'hotkey.enabled.backgroundVoice': false,
    'hotkey.enabled.toggleVoice': false,
    'hotkey.enabled.toggleAiAssets': false,
  },
})

export const storeKey = (action: HotkeyAction): string => `hotkey.${action}`
export const enabledStoreKey = (action: HotkeyAction): string => `hotkey.enabled.${action}`
