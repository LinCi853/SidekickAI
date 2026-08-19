// electron/hotkey/store.ts — 热键配置持久化存储（写入 hotkey.json）

import { createSqliteJsonStore } from '../store/module-state-store.js'
import type { HotkeyAction } from './types.js'

export const DEFAULT_HOTKEYS: Record<HotkeyAction, string> = {
  toggleMainWindow: 'Alt+Space',
  toggleDetachedWindows: 'Alt+Q',
  backgroundVoice: 'Alt+V',
  toggleVoice: '',
}

export const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  toggleMainWindow: '切换主窗口显隐',
  toggleDetachedWindows: '切换脱离窗口显隐',
  backgroundVoice: '后台语音输入（按住）',
  toggleVoice: '语音输入（切换）',
}

/** 同一热键连续触发的去重窗口（ms） */
export const TRIGGER_DEBOUNCE_MS = 200

type HotkeyStoreSchema = {
  'hotkey.toggleMainWindow': string
  'hotkey.toggleDetachedWindows': string
  'hotkey.backgroundVoice': string
  'hotkey.toggleVoice': string
  'hotkey.enabled.toggleMainWindow': boolean
  'hotkey.enabled.toggleDetachedWindows': boolean
  'hotkey.enabled.backgroundVoice': boolean
  'hotkey.enabled.toggleVoice': boolean
  /** 旧版 key（迁移后删除） */
  'hotkey.toggle'?: string
  /** 旧版 key（已下线，迁移时删除） */
  'hotkey.toggleAlwaysOnTop'?: string
}

export const hotkeyStore = createSqliteJsonStore<HotkeyStoreSchema>({
  tableName: 'hotkey_config',
  legacyName: 'hotkey',
  defaults: {
    'hotkey.toggleMainWindow': DEFAULT_HOTKEYS.toggleMainWindow,
    'hotkey.toggleDetachedWindows': DEFAULT_HOTKEYS.toggleDetachedWindows,
    'hotkey.backgroundVoice': DEFAULT_HOTKEYS.backgroundVoice,
    'hotkey.toggleVoice': DEFAULT_HOTKEYS.toggleVoice,
    'hotkey.enabled.toggleMainWindow': true,
    'hotkey.enabled.toggleDetachedWindows': true,
    'hotkey.enabled.backgroundVoice': false,
    'hotkey.enabled.toggleVoice': false,
  },
})

/** 旧版配置迁移：hotkey.toggle -> hotkey.toggleMainWindow */
function migrateLegacyHotkey(): void {
  const legacy = hotkeyStore.get('hotkey.toggle')
  if (typeof legacy === 'string' && legacy) {
    // 仅在新 key 仍为默认值时迁移（避免覆盖用户已设置的新值）
    const current = hotkeyStore.get('hotkey.toggleMainWindow')
    if (current === DEFAULT_HOTKEYS.toggleMainWindow) {
      hotkeyStore.set('hotkey.toggleMainWindow', legacy)
      console.log(
        `[HotkeyManager] 迁移旧热键 hotkey.toggle -> hotkey.toggleMainWindow: ${legacy}`,
      )
    }
    // 删除旧 key
    hotkeyStore.delete('hotkey.toggle')
  }
  // 一次性迁移：删除已下线的 toggleAlwaysOnTop 残留键
  if (hotkeyStore.has('hotkey.toggleAlwaysOnTop')) {
    hotkeyStore.delete('hotkey.toggleAlwaysOnTop')
    console.log('[HotkeyManager] 清理已下线热键 hotkey.toggleAlwaysOnTop')
  }
}

// 启动时迁移一次
migrateLegacyHotkey()

export const storeKey = (action: HotkeyAction): string => `hotkey.${action}`
export const enabledStoreKey = (action: HotkeyAction): string => `hotkey.enabled.${action}`
