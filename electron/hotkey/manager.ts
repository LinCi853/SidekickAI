// electron/hotkey/manager.ts — 全局热键管理器
//
// 支持 2 个可自定义内置热键：
//   - toggleMainWindow（默认 Alt+Space）：切换主窗口显隐
//   - toggleDetachedWindows（默认 Alt+Q）：切换所有脱离窗口显隐
//
// 置顶切换由应用内 F12 处理（window-factory/helpers.ts），不再注册全局热键。
//
// 持久化到 electron-store（hotkey.json），支持从旧版 hotkey.toggle 迁移。
//
// 双保险机制：
//   1. Electron globalShortcut（系统级注册，优先）
//   2. uiohook-napi 低级键盘钩子兜底（监听系统按键事件并匹配组合键）
//
// 由于 uiohook 监听而非拦截，为避免与 globalShortcut 同时触发，
// 所有回调统一经过 200ms 去重窗口，同一 accelerator 在此窗口内只触发一次。

import { globalShortcut } from 'electron'
import Store from 'electron-store'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { checkAccessibilityPermission } from '../utils/permission-manager.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * uiohook-napi 动态加载（已移到 optionalDependencies）。
 *
 * 背景：uiohook-napi 在 macOS / Linux 上需要 Xcode CLT / build-essential 才能编译，
 * 编译失败时 npm install 不会中断（optionalDependencies 语义），但运行时静态 import
 * 会让整个 manager.ts 崩溃。改用 createRequire 动态 require，失败时降级到 mock，
 * HotkeyManager 仅依赖 Electron globalShortcut（系统级注册仍可用，低层钩子兜底失效）。
 */
interface UiohookEvent {
  type: number
  keycode: number
  altKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

interface UiohookModule {
  UiohookKey: Record<string, number>
  EventType: { EVENT_KEY_PRESSED: number; EVENT_KEY_RELEASED: number }
  uIOhook: {
    start(): void
    stop(): void
    on(event: string, cb: (e: UiohookEvent) => void): void
  }
}

function loadUiohook(): UiohookModule | null {
  try {
    const require = createRequire(import.meta.url)
    return require('uiohook-napi') as UiohookModule
  } catch (err) {
    console.warn(
      '[HotkeyManager] uiohook-napi 加载失败，降级到仅 globalShortcut（低层钩子兜底不可用）:',
      err,
    )
    return null
  }
}

const uiohookMod = loadUiohook()
const UiohookKey: Record<string, number> = uiohookMod?.UiohookKey ?? {}
const EventType = uiohookMod?.EventType ?? { EVENT_KEY_PRESSED: 1, EVENT_KEY_RELEASED: 2 }
const uIOhook = uiohookMod?.uIOhook ?? {
  start() { /* no-op: uiohook 不可用 */ },
  stop() { /* no-op */ },
  on(_event: string, _cb: (e: UiohookEvent) => void) { /* no-op */ },
}

// 热键配置持久化存储（写入 hotkey.json）
// cwd 统一走 store-paths，便携模式写入 exe 同级 data/ 目录
import { getStoreCwd as getHotkeyStoreCwd } from '../store/store-paths.js'
import { checkSystemHotkeyConflict } from '../shared/system-hotkeys.js'
const HOTKEY_STORE_CWD = getHotkeyStoreCwd()

/** 内置热键动作标识 */
export type HotkeyAction =
  | 'toggleMainWindow'
  | 'toggleDetachedWindows'
  | 'backgroundVoice'

/** 热键录制回调（主进程 → 渲染层：录制完成后通知） */
export type HotkeyRecordingCallback = (result: { accelerator: string; reason?: string }) => void

/** 热键录制实时反馈回调（每次按键时通知，用于 UI 实时显示当前组合） */
export type HotkeyPartialCallback = (partial: { modifiers: string[]; key: string | null }) => void

/** 热键配置（用于 UI 展示与持久化） */
export interface HotkeyConfig {
  action: HotkeyAction
  /** 显示名称 */
  label: string
  /** accelerator 字符串 */
  accelerator: string
  /** 是否启用（false 时热键不注册、不响应） */
  enabled: boolean
}

const DEFAULT_HOTKEYS: Record<HotkeyAction, string> = {
  toggleMainWindow: 'Alt+Space',
  toggleDetachedWindows: 'Alt+Q',
  backgroundVoice: 'Alt+V',
}

const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  toggleMainWindow: '切换主窗口显隐',
  toggleDetachedWindows: '切换脱离窗口显隐',
  backgroundVoice: '后台语音输入（按住）',
}

/** 同一热键连续触发的去重窗口（ms） */
const TRIGGER_DEBOUNCE_MS = 200

type HotkeyStoreSchema = {
  'hotkey.toggleMainWindow': string
  'hotkey.toggleDetachedWindows': string
  'hotkey.backgroundVoice': string
  'hotkey.enabled.toggleMainWindow': boolean
  'hotkey.enabled.toggleDetachedWindows': boolean
  'hotkey.enabled.backgroundVoice': boolean
  /** 旧版 key（迁移后删除） */
  'hotkey.toggle'?: string
  /** 旧版 key（已下线，迁移时删除） */
  'hotkey.toggleAlwaysOnTop'?: string
}

const hotkeyStore = new Store<HotkeyStoreSchema>({
  name: 'hotkey',
  cwd: HOTKEY_STORE_CWD,
  defaults: {
    'hotkey.toggleMainWindow': DEFAULT_HOTKEYS.toggleMainWindow,
    'hotkey.toggleDetachedWindows': DEFAULT_HOTKEYS.toggleDetachedWindows,
    'hotkey.backgroundVoice': DEFAULT_HOTKEYS.backgroundVoice,
    'hotkey.enabled.toggleMainWindow': true,
    'hotkey.enabled.toggleDetachedWindows': true,
    // 后台语音默认关闭（测试功能，需用户主动启用）
    'hotkey.enabled.backgroundVoice': false,
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

const storeKey = (action: HotkeyAction): string => `hotkey.${action}`
const enabledStoreKey = (action: HotkeyAction): string => `hotkey.enabled.${action}`

/** accelerator 字符串 -> uiohook 按键代码（字母/数字/功能键） */
function acceleratorToUiohookKey(part: string): number | null {
  const upper = part.toUpperCase()

  // 字母 A-Z
  if (/^[A-Z]$/.test(upper)) {
    return UiohookKey[upper as keyof typeof UiohookKey] as number
  }

  // 数字 0-9
  if (/^\d$/.test(upper)) {
    return UiohookKey[upper as '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9']
  }

  // 功能键 F1-F24
  const fMatch = /^F(\d{1,2})$/.exec(upper)
  if (fMatch) {
    const key = `F${fMatch[1]}` as keyof typeof UiohookKey
    if (key in UiohookKey) return UiohookKey[key] as number
  }

  // 特殊键
  const map: Record<string, number> = {
    SPACE: UiohookKey.Space,
    SPACEBAR: UiohookKey.Space,
    ENTER: UiohookKey.Enter,
    RETURN: UiohookKey.Enter,
    TAB: UiohookKey.Tab,
    ESC: UiohookKey.Escape,
    ESCAPE: UiohookKey.Escape,
    BACKSPACE: UiohookKey.Backspace,
    DELETE: UiohookKey.Delete,
    INSERT: UiohookKey.Insert,
    HOME: UiohookKey.Home,
    END: UiohookKey.End,
    PAGEUP: UiohookKey.PageUp,
    PAGEDOWN: UiohookKey.PageDown,
    UP: UiohookKey.ArrowUp,
    DOWN: UiohookKey.ArrowDown,
    LEFT: UiohookKey.ArrowLeft,
    RIGHT: UiohookKey.ArrowRight,
    PLUS: UiohookKey.Equal, // Electron 用 Plus 表示 "=" 加 Shift，uiohook 无 Plus，映射为 Equal
    EQUAL: UiohookKey.Equal,
    MINUS: UiohookKey.Minus,
    COMMA: UiohookKey.Comma,
    PERIOD: UiohookKey.Period,
    SLASH: UiohookKey.Slash,
    SEMICOLON: UiohookKey.Semicolon,
    QUOTE: UiohookKey.Quote,
    BACKTICK: UiohookKey.Backquote,
    BRACKETLEFT: UiohookKey.BracketLeft,
    BRACKETRIGHT: UiohookKey.BracketRight,
    BACKSLASH: UiohookKey.Backslash,
  }
  return map[upper] ?? null
}

/** 解析 accelerator 字符串为匹配条件 */
function parseAccelerator(acc: string): {
  keycode: number | null
  alt: boolean
  ctrl: boolean
  shift: boolean
  meta: boolean
} {
  const parts = acc.split('+').map((p) => p.trim())
  let alt = false
  let ctrl = false
  let shift = false
  let meta = false
  let keyPart = ''

  for (const part of parts) {
    const up = part.toUpperCase()
    if (up === 'ALT' || up === 'OPTION') alt = true
    else if (up === 'CTRL' || up === 'CONTROL') ctrl = true
    else if (up === 'SHIFT') shift = true
    else if (up === 'CMD' || up === 'COMMAND' || up === 'META' || up === 'SUPER') meta = true
    else keyPart = part
  }

  return {
    keycode: keyPart ? acceleratorToUiohookKey(keyPart) : null,
    alt,
    ctrl,
    shift,
    meta,
  }
}

/**
 * 全局热键管理器
 *
 * accelerator 格式遵循 Electron 规范，如 "Alt+Space"、"Ctrl+Shift+P"。
 * 内部维护 accelerator -> callback 映射，用于 isRegistered 查询与批量注销。
 */

// 模块级单例引用：供 app-settings-store 注册浏览器快捷键 IPC 时获取，
// 避免修改 main.ts 调用链（registerAppSettingsIPC 不接受 hotkeyManager 参数）。
// HotkeyManager 在 main.ts 中仅 new 一次，此引用在构造时设置。
let _hotkeyManagerInstance: HotkeyManager | null = null

/** 获取全局唯一的 HotkeyManager 实例（未初始化时返回 null） */
export function getHotkeyManagerInstance(): HotkeyManager | null {
  return _hotkeyManagerInstance
}

export class HotkeyManager {
  /** accelerator -> 回调（已注册项，含 globalShortcut 与 uiohook 兜底） */
  private registered = new Map<string, () => void>()
  /** 浏览器窗口快捷键 accelerator -> 回调（C4：scope='global' 的浏览器快捷键，独立跟踪） */
  private browserShortcuts = new Map<string, () => void>()
  /** action -> accelerator（当前已注册的内置热键映射） */
  private actionAccelerators = new Map<HotkeyAction, string>()
  /** uiohook 是否已启动 */
  private uiohookStarted = false
  /** 已注册 accelerator 的 uiohook 匹配条件缓存 */
  private uiohookMatchers = new Map<string, ReturnType<typeof parseAccelerator> & { callback: () => void }>()
  /** 最近触发时间戳（用于去重） */
  private lastTriggeredAt = new Map<string, number>()
  /** 语音热键匹配器（独立于主映射，仅 uiohook keydown/keyup，不走 globalShortcut） */
  private voiceMatcher: {
    keycode: number | null
    alt: boolean
    ctrl: boolean
    shift: boolean
    meta: boolean
    onKeyDown: () => void
    onKeyUp: () => void
  } | null = null
  /**
   * 语音热键「按下中」状态：记录 V 是否处于按下 + Alt 是否匹配。
   * 用于解决"先松 Alt 再松 V 时 keyup 严格匹配失败"的问题：
   *   - 严格匹配场景：用户先松 V 再松 Alt → V keyup 时 altKey=true 匹配成功
   *   - 严格匹配失败场景：用户先松 Alt 再松 V → V keyup 时 altKey=false 不匹配
   * 用"按下态"标记后：V keyup 时若处于 pressed 状态，无视当前 altKey 状态直接触发 onKeyUp。
   */
  private voiceKeyPressed = false
  /**
   * 最近一次 V keydown 的时间戳（用于轮询检测"按键是否还在按"）。
   * OS 长按时会按 ~30-50ms 间隔重复发 keydown；用户真正松开后，OS 不再发 keydown。
   * 但 uiohook 在 Windows 上对 auto-repeat 的转发可能不完整（间隔远大于 OS 间隔），
   * 因此阈值不能太短，否则会把"长按中但 uiohook 暂未转发 repeat"误判为松开。
   * 当前阈值 1500ms：仅在 uiohook keyup 完全丢失且超过 1.5s 没有任何 keydown 时兜底。
   */
  private voiceLastKeydownAt = 0
  /** 500ms 轮询 timer id（兜底检测 keyup 丢失，阈值放宽避免误判 auto-repeat） */
  private voicePollingTimer: ReturnType<typeof setInterval> | null = null
  /** keydown 日志节流时间戳（避免 OS 重复 keydown 打爆日志） */
  private _lastKeydownLogAt = 0
  /**
   * 当前语音热键注销函数（由 registerVoiceHotkey 返回，外部保存以便重注册时调用）。
   * HOTKEY_SET（backgroundVoice 自定义）与 HOTKEY_SET_ENABLED（启用/禁用）共用此字段。
   */
  voiceUnregisterFn: (() => void) | null = null

  /** 热键录制状态：null 表示未录制，非 null 表示录制中（含回调） */
  private _recordingCallback: HotkeyRecordingCallback | null = null
  /** 录制实时反馈回调（每次按键时调用，用于 UI 显示当前组合） */
  private _recordingPartialCallback: HotkeyPartialCallback | null = null
  /** 录制期间临时注册的抑制器 accelerator 列表（用于阻止系统菜单等） */
  private _recordingSuppressors: string[] = []
  /** 录制前已注册的热键备份（用于录制结束后恢复） */
  private _recordingBackup: Array<{ accelerator: string; callback: () => void }> = []
  /** 暂停状态：true 时跳过所有全局热键匹配（如使用指南窗口打开时） */
  private _paused = false
  /** uiohook keycode → Electron accelerator 主键名的反向映射 */
  private _uiohookKeyToName = new Map<number, string>()

  /**
   * 修饰键实时按下状态（独立追踪，解决 uiohook altKey 状态残留问题）。
   *
   * 问题场景：Windows 上 Alt+Tab 切换窗口后，Alt 的 keyup 事件可能未被
   * uiohook 捕获，导致后续所有按键事件的 altKey 字段都为 true，
   * 从而单独按 Space 也会误匹配 Alt+Space 热键。
   *
   * 解决方案：通过 keydown/keyup 事件自行追踪修饰键状态，
   * 匹配时使用追踪值而非事件自带的 altKey/ctrlKey/shiftKey/metaKey。
   */
  private modAlt = false
  private modCtrl = false
  private modShift = false
  private modMeta = false
  /** 修饰键 keycode 集合（按 Alt/Ctrl/Shift/Meta 分类） */
  private _modKeyCodes: { alt: Set<number>; ctrl: Set<number>; shift: Set<number>; meta: Set<number> } = {
    alt: new Set(),
    ctrl: new Set(),
    shift: new Set(),
    meta: new Set(),
  }

  constructor() {
    this.buildUiohookKeyMap()
    this.buildModifierKeyCodes()
    this.attachUiohookListener()
    // 记录单例引用（供 app-settings-store 注册浏览器快捷键 IPC 时获取）
    _hotkeyManagerInstance = this
  }

  /** 扫描 UiohookKey 枚举，收集各修饰键的所有 keycode（含左/右变体） */
  private buildModifierKeyCodes(): void {
    for (const key of Object.keys(UiohookKey)) {
      const kc = UiohookKey[key]
      if (typeof kc !== 'number') continue
      const up = key.toUpperCase()
      if (up === 'ALT' || up === 'LEFTALT' || up === 'RIGHTALT') this._modKeyCodes.alt.add(kc)
      else if (up === 'CTRL' || up === 'CONTROL' || up === 'LEFTCTRL' || up === 'RIGHTCTRL') this._modKeyCodes.ctrl.add(kc)
      else if (up === 'SHIFT' || up === 'LEFTSHIFT' || up === 'RIGHTSHIFT') this._modKeyCodes.shift.add(kc)
      else if (up === 'META' || up === 'LEFTMETA' || up === 'RIGHTMETA' || up === 'SUPER' || up === 'LEFTSUPER' || up === 'RIGHTSUPER' || up === 'COMMAND') this._modKeyCodes.meta.add(kc)
    }
  }

  /** 构建 uiohook keycode → Electron 键名的反向映射 */
  private buildUiohookKeyMap(): void {
    // 字母 A-Z
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(65 + i)
      const kc = UiohookKey[letter as keyof typeof UiohookKey]
      if (typeof kc === 'number') this._uiohookKeyToName.set(kc, letter)
    }
    // 数字 0-9
    for (let i = 0; i <= 9; i++) {
      const kc = UiohookKey[String(i) as keyof typeof UiohookKey]
      if (typeof kc === 'number') this._uiohookKeyToName.set(kc, String(i))
    }
    // 功能键 F1-F24
    for (let i = 1; i <= 24; i++) {
      const fname = `F${i}`
      const kc = UiohookKey[fname as keyof typeof UiohookKey]
      if (typeof kc === 'number') this._uiohookKeyToName.set(kc, fname)
    }
    // 特殊键
    const specialMap: Array<[string, string]> = [
      ['Space', 'Space'], ['Enter', 'Enter'], ['Escape', 'Esc'], ['Tab', 'Tab'],
      ['Backspace', 'Backspace'], ['Delete', 'Delete'], ['Insert', 'Insert'],
      ['Home', 'Home'], ['End', 'End'], ['PageUp', 'PageUp'], ['PageDown', 'PageDown'],
      ['ArrowUp', 'Up'], ['ArrowDown', 'Down'], ['ArrowLeft', 'Left'], ['ArrowRight', 'Right'],
      ['Equal', '='], ['Minus', '-'], ['Comma', ','], ['Period', '.'],
      ['Slash', '/'], ['Semicolon', ';'], ['Quote', "'"], ['Backquote', '`'],
      ['BracketLeft', '['], ['BracketRight', ']'], ['Backslash', '\\'],
    ]
    for (const [uk, name] of specialMap) {
      const kc = UiohookKey[uk]
      if (typeof kc === 'number') this._uiohookKeyToName.set(kc, name)
    }
  }

  /**
   * 注册热键
   * 主路径 globalShortcut，同时加入 uiohook 兜底监听。
   * 只要其中一路生效，热键即可工作。
   * @returns globalShortcut 是否注册成功
   */
  async register(accelerator: string, callback: () => void): Promise<boolean> {
    // 若已注册同名热键，先注销以避免冲突
    if (this.registered.has(accelerator)) {
      this.unregister(accelerator)
    }

    // 包装回调：加入去重窗口
    const throttledCallback = () => this.trigger(accelerator, callback)
    this.registered.set(accelerator, throttledCallback)

    // 加入 uiohook 匹配器（兜底）
    this.uiohookMatchers.set(accelerator, {
      ...parseAccelerator(accelerator),
      callback: throttledCallback,
    })
    this.ensureUiohookStarted()

    // ---- 主路径：globalShortcut ----
    try {
      // 预检查：若已被占用（本应用或其他应用），记录警告
      if (globalShortcut.isRegistered(accelerator)) {
        console.warn(`[HotkeyManager] 热键已被占用: ${accelerator}`)
      }
      const ok = globalShortcut.register(accelerator, throttledCallback)
      if (ok) {
        console.log(`[HotkeyManager] globalShortcut 注册成功: ${accelerator}`)
        return true
      }
      console.warn(
        (() => {
          const sysConflict = checkSystemHotkeyConflict(accelerator)
          const hint = sysConflict ? `，可能与系统快捷键「${sysConflict.label}」冲突` : ''
          return `[HotkeyManager] globalShortcut 注册失败: ${accelerator}${hint}，已启用 uiohook 兜底`
        })(),
      )
    } catch (err) {
      console.warn(
        `[HotkeyManager] globalShortcut 注册异常: ${accelerator}，已启用 uiohook 兜底`,
        err,
      )
    }

    return false
  }

  /** 统一触发入口：200ms 去重，避免 globalShortcut + uiohook 双触发 */
  private trigger(accelerator: string, callback: () => void): void {
    const now = Date.now()
    const last = this.lastTriggeredAt.get(accelerator) ?? 0
    if (now - last < TRIGGER_DEBOUNCE_MS) {
      console.log(`[HotkeyManager] 触发去重: ${accelerator}`)
      return
    }
    this.lastTriggeredAt.set(accelerator, now)
    console.log(`[HotkeyManager] 触发: ${accelerator}`)
    try {
      callback()
    } catch (err) {
      console.error(`[HotkeyManager] 热键回调异常: ${accelerator}`, err)
    }
  }

  /** 启动 uiohook 监听（幂等） */
  private ensureUiohookStarted(): void {
    if (this.uiohookStarted) return
    // macOS 需要辅助功能权限才能使用 uiohook 低级键盘钩子
    if (process.platform === 'darwin' && !checkAccessibilityPermission()) {
      console.warn(
        '[HotkeyManager] macOS 辅助功能权限未授权，uiohook 不可用，降级为仅 globalShortcut',
      )
      return
    }
    try {
      uIOhook.start()
      this.uiohookStarted = true
      console.log('[HotkeyManager] uiohook 监听已启动')
    } catch (err) {
      console.error('[HotkeyManager] uiohook 启动失败:', err)
    }
  }

  /** 附加 uiohook keydown/keyup 监听器 */
  private attachUiohookListener(): void {
    uIOhook.on('keydown', (e) => {
      if (e.type !== EventType.EVENT_KEY_PRESSED) return
      // 追踪修饰键按下状态（解决 uiohook altKey 状态残留导致误触发）
      if (this._modKeyCodes.alt.has(e.keycode)) this.modAlt = true
      if (this._modKeyCodes.ctrl.has(e.keycode)) this.modCtrl = true
      if (this._modKeyCodes.shift.has(e.keycode)) this.modShift = true
      if (this._modKeyCodes.meta.has(e.keycode)) this.modMeta = true
      // 录制模式：跳过常规热键匹配，仅由 handleRecordingKeydown 处理
      if (this._recordingCallback) {
        this.handleRecordingKeydown(e)
        return
      }
      // 暂停状态：跳过所有热键匹配（如使用指南窗口打开时）
      if (this._paused) return
      // 主映射（globalShortcut 兜底）：使用追踪的修饰键状态而非事件自带字段
      for (const [acc, matcher] of this.uiohookMatchers) {
        if (!matcher.keycode) continue
        if (
          e.keycode === matcher.keycode &&
          this.modAlt === matcher.alt &&
          this.modCtrl === matcher.ctrl &&
          this.modShift === matcher.shift &&
          this.modMeta === matcher.meta
        ) {
          matcher.callback()
          return
        }
      }
      // 语音热键 keydown：要求主键 + 必备修饰键匹配，其它修饰键（Ctrl/Shift/Meta）允许不一致
      if (this.voiceMatcher && this.voiceMatcher.keycode) {
        const m = this.voiceMatcher
        if (
          e.keycode === m.keycode &&
          (m.alt ? this.modAlt : true) &&
          (m.ctrl ? this.modCtrl : true) &&
          (m.shift ? this.modShift : true) &&
          (m.meta ? this.modMeta : true)
        ) {
          // 关键修复：长按时 OS 会重复发 keydown 事件（每 ~30ms 一次），
          // 之前每次都触发 onKeyDown → startBackgroundVoice → 上轮未 stop → 自愈循环
          // 导致 UI 一直 start-stop-start 闪烁。用 voiceKeyPressed 标志去重：
          // 已经在录音中时，重复 keydown 一律忽略，保留 onKeyUp 释放录音的逻辑不变。
          if (this.voiceKeyPressed) {
            // 已经在录音中：忽略重复 keydown（包括 OS 重复和 uiohook 偶发双发）
            // 但要刷新"最近一次 keydown 时间戳"，让轮询检测知道按键还活着
            this.voiceLastKeydownAt = Date.now()
            return
          }
          // 标记按下状态：用于后续 keyup 触发 onKeyUp（即使 modifier 已松开）
          this.voiceKeyPressed = true
          this.voiceLastKeydownAt = Date.now()
          this.startVoicePolling()
          try {
            m.onKeyDown()
          } catch (err) {
            console.error('[HotkeyManager] 语音热键 keydown 回调异常', err)
          }
        }
      }
    })
    uIOhook.on('keyup', (e) => {
      if (e.type !== EventType.EVENT_KEY_RELEASED) return
      // 追踪修饰键释放状态（与 keydown 配对，解决 uiohook altKey 状态残留）
      if (this._modKeyCodes.alt.has(e.keycode)) this.modAlt = false
      if (this._modKeyCodes.ctrl.has(e.keycode)) this.modCtrl = false
      if (this._modKeyCodes.shift.has(e.keycode)) this.modShift = false
      if (this._modKeyCodes.meta.has(e.keycode)) this.modMeta = false
      // 语音热键 keyup：主键匹配就触发 onKeyUp
      // 1) voiceKeyPressed=true 时 → 标准路径（已记录按下态）
      // 2) voiceKeyPressed=false 时 → 兜底路径：可能 keydown 事件因任何原因丢失，
      //    直接信任 keyup 的主键匹配，仍然补发 onKeyUp，让录音能正常结束
      if (this.voiceMatcher && this.voiceMatcher.keycode) {
        const m = this.voiceMatcher
        if (e.keycode === m.keycode) {
          console.log(
            `[HotkeyManager] 语音热键 keyup: keycode=${e.keycode} altKey=${e.altKey} voiceKeyPressed=${this.voiceKeyPressed}`,
          )
          // 只有在按下态匹配时才清零（避免多次 keyup 重复触发）
          if (this.voiceKeyPressed) {
            this.voiceKeyPressed = false
            this.stopVoicePolling()
          }
          try {
            m.onKeyUp()
          } catch (err) {
            console.error('[HotkeyManager] 语音热键 keyup 回调异常', err)
          }
        }
      }
    })
  }

  /**
   * 启动 500ms 轮询：当 voiceKeyPressed=true 时，每 500ms 检查一次
   * "距上次 V keydown 是否超过 1500ms"：
   *   - 是 → 强制触发 onKeyUp（兜底：uiohook keyup 完全丢失）
   *   - 否 → 继续轮询
   *
   * 设计说明：
   *   - 主释放信号是 uiohook keyup 事件（用户松开按键时立即触发）
   *   - 轮询仅作 keyup 丢失兜底，阈值 1500ms 远大于 uiohook auto-repeat 间隔，
   *     避免把"长按中但 uiohook 暂未转发 repeat keydown"误判为松开
   *   - 同时处理"按下 V 但 uiohook 完全没收到 keydown"的情况：
   *     voiceKeyPressed 永远 false → 轮询不启动 → V keyup 兜底路径触发 onKeyUp
   */
  private startVoicePolling(): void {
    if (this.voicePollingTimer) return
    this.voicePollingTimer = setInterval(() => {
      if (!this.voiceKeyPressed) {
        this.stopVoicePolling()
        return
      }
      const now = Date.now()
      const elapsed = now - this.voiceLastKeydownAt
      // 阈值 1500ms：远大于 uiohook auto-repeat 间隔，仅兜底 keyup 完全丢失
      if (elapsed > 1500) {
        console.log(
          `[HotkeyManager] 轮询兜底：V 键 keyup 丢失（距上次 keydown ${elapsed}ms），强制触发 onKeyUp`,
        )
        this.voiceKeyPressed = false
        this.stopVoicePolling()
        if (this.voiceMatcher) {
          try {
            this.voiceMatcher.onKeyUp()
          } catch (err) {
            console.error('[HotkeyManager] 轮询 onKeyUp 异常:', err)
          }
        }
      }
    }, 500)
  }

  /** 停止轮询 */
  private stopVoicePolling(): void {
    if (this.voicePollingTimer) {
      clearInterval(this.voicePollingTimer)
      this.voicePollingTimer = null
    }
  }

  /** 注销指定热键 */
  unregister(accelerator: string): void {
    try {
      globalShortcut.unregister(accelerator)
    } catch (err) {
      console.warn(`[HotkeyManager] 注销 globalShortcut 异常: ${accelerator}`, err)
    }
    this.registered.delete(accelerator)
    this.uiohookMatchers.delete(accelerator)
    this.lastTriggeredAt.delete(accelerator)
  }

  /**
   * 注册浏览器窗口全局快捷键（C4：scope='global' 的浏览器快捷键）。
   *
   * 走 globalShortcut 主路径 + uiohook 兜底，与内置热键 register() 一致；
   * 独立跟踪到 browserShortcuts 映射，避免与内置热键回调混淆，
   * 注销时可按 accelerator 精确移除。
   *
   * @returns globalShortcut 是否注册成功（失败时仍有 uiohook 兜底）
   */
  registerBrowserShortcut(accelerator: string, callback: () => void): boolean {
    // 若已注册同名浏览器快捷键，先注销
    if (this.browserShortcuts.has(accelerator)) {
      this.unregisterBrowserShortcut(accelerator)
    }
    this.browserShortcuts.set(accelerator, callback)
    // 加入 uiohook 匹配器（兜底），复用主映射机制
    if (!this.uiohookMatchers.has(accelerator)) {
      this.uiohookMatchers.set(accelerator, {
        ...parseAccelerator(accelerator),
        callback,
      })
    }
    this.ensureUiohookStarted()
    // 主路径：globalShortcut
    try {
      if (globalShortcut.isRegistered(accelerator)) {
        globalShortcut.unregister(accelerator)
      }
      const ok = globalShortcut.register(accelerator, callback)
      if (ok) {
        console.log(`[HotkeyManager] 浏览器全局快捷键注册成功: ${accelerator}`)
        return true
      }
      console.warn(
        `[HotkeyManager] 浏览器全局快捷键注册失败: ${accelerator}，已启用 uiohook 兜底`,
      )
    } catch (err) {
      console.warn(`[HotkeyManager] 浏览器全局快捷键注册异常: ${accelerator}`, err)
    }
    return false
  }

  /** 注销浏览器窗口全局快捷键 */
  unregisterBrowserShortcut(accelerator: string): void {
    try {
      globalShortcut.unregister(accelerator)
    } catch (err) {
      console.warn(`[HotkeyManager] 注销浏览器全局快捷键异常: ${accelerator}`, err)
    }
    this.browserShortcuts.delete(accelerator)
    // 仅当内置热键主映射未使用该 accelerator 时才清理 uiohook 匹配器
    if (!this.registered.has(accelerator)) {
      this.uiohookMatchers.delete(accelerator)
    }
    this.lastTriggeredAt.delete(accelerator)
  }

  /**
   * 注销全部浏览器窗口全局快捷键（reregisterProfileShortcuts 调用前置清理）。
   * 遍历 browserShortcuts 映射逐条注销，避免影响内置热键 registered 映射。
   */
  unregisterAllBrowserShortcuts(): void {
    for (const accelerator of Array.from(this.browserShortcuts.keys())) {
      this.unregisterBrowserShortcut(accelerator)
    }
  }

  /**
   * 检查是否已注册
   * 基于本管理器内部映射判断（含 uiohook 兜底项）。
   */
  isRegistered(accelerator: string): boolean {
    return this.registered.has(accelerator)
  }

  /** 注销全部热键（应用退出时调用） */
  unregisterAll(): void {
    try {
      globalShortcut.unregisterAll()
    } catch (err) {
      console.warn('[HotkeyManager] unregisterAll 异常', err)
    }
    this.registered.clear()
    this.browserShortcuts.clear()
    this.actionAccelerators.clear()
    this.uiohookMatchers.clear()
    this.lastTriggeredAt.clear()
    this.voiceMatcher = null
    if (this.uiohookStarted) {
      try {
        uIOhook.stop()
      } catch (err) {
        console.warn('[HotkeyManager] uiohook stop 异常', err)
      }
      this.uiohookStarted = false
    }
  }

  /** 获取某个内置热键的 accelerator（从 store 读取） */
  getHotkey(action: HotkeyAction): string {
    return hotkeyStore.get(storeKey(action)) ?? DEFAULT_HOTKEYS[action]
  }

  /** 读取某个内置热键的启用状态（从 store；缺失时回退 true） */
  getEnabled(action: HotkeyAction): boolean {
    const v = hotkeyStore.get(enabledStoreKey(action))
    return typeof v === 'boolean' ? v : true
  }

  /**
   * 持久化某个内置热键的启用状态。
   * 注意：本方法仅写 store，不负责注册/注销。调用方需在调用前后自行管理注册：
   *   - enabled=false → 调用方应先 unregister(getActionAccelerator(action))
   *   - enabled=true  → 调用方应后 register(getHotkey(action), callback)
   */
  setEnabled(action: HotkeyAction, enabled: boolean): void {
    hotkeyStore.set(enabledStoreKey(action), enabled)
  }

  /** 获取全部内置热键配置（供 UI 展示，含 enabled 状态） */
  getAllHotkeys(): HotkeyConfig[] {
    return (Object.keys(DEFAULT_HOTKEYS) as HotkeyAction[]).map((action) => ({
      action,
      label: HOTKEY_LABELS[action],
      accelerator: this.getHotkey(action),
      enabled: this.getEnabled(action),
    }))
  }

  /**
   * 设置某个内置热键（仅持久化到 store，不负责注销/注册）
   * 调用方需在调用前注销旧 accelerator，调用后注册新 accelerator。
   */
  setHotkey(action: HotkeyAction, accelerator: string): void {
    hotkeyStore.set(storeKey(action), accelerator)
  }

  /** 记录某个 action 当前已注册的 accelerator（供后续 reassign 注销旧值） */
  recordActionAccelerator(action: HotkeyAction, accelerator: string): void {
    this.actionAccelerators.set(action, accelerator)
  }

  /** 获取某个 action 当前已注册的 accelerator（未注册时回退到 store） */
  getActionAccelerator(action: HotkeyAction): string {
    return this.actionAccelerators.get(action) ?? this.getHotkey(action)
  }

  /**
   * 注册默认内置热键（2 个）
   * 注册结果逐条输出日志，便于排查占用问题。
   * @returns 每个动作的注册结果（true=globalShortcut 成功）
   */
  async registerDefaultShortcuts(callbacks: {
    toggleMainWindow: () => void
    toggleDetachedWindows: () => void
  }): Promise<Record<HotkeyAction, boolean>> {
    const actions = [
      'toggleMainWindow',
      'toggleDetachedWindows',
    ] as const
    const results = {} as Record<HotkeyAction, boolean>
    for (const action of actions) {
      // 启动注册时跳过被禁用的热键
      if (!this.getEnabled(action)) {
        results[action] = false
        console.log(`[HotkeyManager] 内置热键 ${action} 已禁用，跳过注册`)
        continue
      }
      const acc = this.getHotkey(action)
      const cb = callbacks[action]
      const ok = await this.register(acc, cb)
      results[action] = ok
      if (ok) {
        this.recordActionAccelerator(action, acc)
        console.log(`[HotkeyManager] 内置热键 ${action} (${acc}) 注册成功`)
      } else {
        console.warn(
          `[HotkeyManager] 内置热键 ${action} (${acc}) globalShortcut 未成功，已启用 uiohook 兜底`,
        )
      }
    }
    return results
  }

  /**
   * 注册语音热键（Alt+V hold-to-record）
   *
   * 仅用 uiohook 监听 keydown/keyup（globalShortcut 不支持 keyup）。
   * 不进入 registered/uiohookMatchers 主映射，独立管理。
   *
   * @returns 注销函数（调用后停止监听）
   */
  registerVoiceHotkey(
    accelerator: string,
    onKeyDown: () => void,
    onKeyUp: () => void,
  ): () => void {
    const parsed = parseAccelerator(accelerator)
    this.voiceMatcher = {
      keycode: parsed.keycode,
      alt: parsed.alt,
      ctrl: parsed.ctrl,
      shift: parsed.shift,
      meta: parsed.meta,
      onKeyDown,
      onKeyUp,
    }
    // 注册时清空按下态（避免上次未正确释放的残留状态）
    this.voiceKeyPressed = false
    this.voiceLastKeydownAt = 0
    this.stopVoicePolling()
    this.ensureUiohookStarted()
    if (this.uiohookStarted) {
      console.log(`[HotkeyManager] 语音热键已注册: ${accelerator} (仅 uiohook keydown/keyup)`)
    } else {
      console.warn(
        `[HotkeyManager] 语音热键 ${accelerator} 已注册但 uiohook 未启动（macOS 辅助功能权限未授权或 Wayland 环境），语音热键将无法触发`,
      )
    }
    return () => {
      this.voiceMatcher = null
      this.voiceKeyPressed = false
      this.voiceLastKeydownAt = 0
      this.stopVoicePolling()
      console.log(`[HotkeyManager] 语音热键已注销: ${accelerator}`)
    }
  }

  /**
   * 处理录制模式下的 uiohook keydown 事件。
   * 从 uiohook 事件构建 accelerator 字符串，检测可用性后通知回调。
   */
  private handleRecordingKeydown(e: UiohookEvent): void {
    // 实时反馈：在任何过滤之前，发送当前按键状态给渲染层
    if (this._recordingPartialCallback) {
      const partialMods: string[] = []
      if (e.ctrlKey) partialMods.push('Ctrl')
      if (e.altKey) partialMods.push('Alt')
      if (e.shiftKey) partialMods.push('Shift')
      if (e.metaKey) partialMods.push('Meta')
      const partialKeyName = this._uiohookKeyToName.get(e.keycode)
      // 修饰键自身按下时，不重复显示为 key
      const isModifierKey = ['Ctrl', 'Alt', 'Shift', 'Meta', 'Super'].includes(partialKeyName || '')
      this._recordingPartialCallback({
        modifiers: partialMods,
        key: isModifierKey || !partialKeyName ? null : partialKeyName,
      })
    }

    // 仅修饰键，等待下一个按键
    const keyName = this._uiohookKeyToName.get(e.keycode)
    if (!keyName) return

    // Escape 取消录制（仅无修饰键时）
    if (keyName === 'Esc' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      this.finishRecording('')
      return
    }

    // 必须至少包含 Ctrl/Alt/Meta
    if (!e.ctrlKey && !e.altKey && !e.metaKey) return

    const accParts: string[] = []
    if (e.ctrlKey) accParts.push('Ctrl')
    if (e.altKey) accParts.push('Alt')
    if (e.shiftKey) accParts.push('Shift')
    if (e.metaKey) accParts.push('Meta')
    accParts.push(keyName)
    const accelerator = accParts.join('+')

    // 检测可用性：尝试 globalShortcut.register
    // 如果被我们的抑制器注册了（临时阻止系统菜单的空回调），先注销再试
    let reason: string | undefined
    const isSuppressed = this._recordingSuppressors.includes(accelerator)
    try {
      if (isSuppressed) {
        globalShortcut.unregister(accelerator)
      }
      // 尝试全局注册：成功 = 无其他应用占用；失败 = 被系统或其他应用占用
      const regOk = globalShortcut.register(accelerator, () => {})
      if (regOk) {
        globalShortcut.unregister(accelerator)
        // 重新注册抑制器（继续阻止系统菜单直到录制结束）
        if (isSuppressed) {
          globalShortcut.register(accelerator, () => {})
        }
      } else {
        const sysConflict = checkSystemHotkeyConflict(accelerator)
        reason = sysConflict
          ? `快捷键 ${accelerator} 与系统快捷键「${sysConflict.label}」冲突，请换一个组合`
          : `快捷键 ${accelerator} 已被系统或其他应用占用，请换一个组合`
        // 重新注册抑制器
        if (isSuppressed) {
          globalShortcut.register(accelerator, () => {})
        }
      }
    } catch (err) {
      reason = `快捷键 ${accelerator} 格式不支持（${err instanceof Error ? err.message : String(err)}）`
      if (isSuppressed) {
        globalShortcut.register(accelerator, () => {})
      }
    }

    this.finishRecording(accelerator, reason)
  }

  /** 完成录制（成功或失败） */
  private finishRecording(accelerator: string, reason?: string): void {
    const cb = this._recordingCallback
    this.restoreAfterRecording()
    if (cb) {
      cb({ accelerator, reason })
    }
  }

  /** 录制结束后恢复：注销所有抑制器，恢复原有热键回调 */
  private restoreAfterRecording(): void {
    // 注销所有抑制器
    for (const supAcc of this._recordingSuppressors) {
      try { globalShortcut.unregister(supAcc) } catch { /* ignore */ }
    }
    // 恢复原有热键回调
    for (const { accelerator, callback } of this._recordingBackup) {
      try {
        globalShortcut.register(accelerator, callback)
      } catch {
        // ignore
      }
    }
    this._recordingSuppressors = []
    this._recordingBackup = []
    this._recordingCallback = null
    this._recordingPartialCallback = null
  }

  /**
   * 开始录制热键。
   * 使用 uiohook（系统级键盘钩子）捕获按键，能可靠检测 Alt+Space 等被系统拦截的组合。
   * 临时注册常见系统快捷键作为抑制器（空回调），阻止系统菜单弹出。
   * 通过 globalShortcut.register 检测所有应用（含外部应用）的占用情况。
   * @returns 是否成功进入录制状态
   */
  async startRecording(callback: HotkeyRecordingCallback, onPartial?: HotkeyPartialCallback): Promise<boolean> {
    if (this._recordingCallback) {
      this.stopRecording()
    }
    this._recordingCallback = callback
    this._recordingPartialCallback = onPartial ?? null

    // 启动 uiohook（录制依赖系统级键盘监听）
    this.ensureUiohookStarted()
    if (!this.uiohookStarted) {
      this._recordingCallback = null
      return false
    }

    // 临时将本应用已注册的 globalShortcut 热键替换为空回调抑制器，
    // 防止录制期间触发原有功能（如 Alt+Space 切换窗口）
    for (const [acc, cb] of this.registered) {
      try {
        if (globalShortcut.isRegistered(acc)) {
          globalShortcut.unregister(acc)
          const ok = globalShortcut.register(acc, () => {})
          if (ok) {
            this._recordingBackup.push({ accelerator: acc, callback: cb })
            this._recordingSuppressors.push(acc)
          } else {
            // 重新注册失败则恢复原回调
            globalShortcut.register(acc, cb)
          }
        }
      } catch {
        // 忽略
      }
    }

    // 临时注册常见 Windows 系统快捷键作为抑制器，阻止系统菜单/窗口操作弹出
    const systemSuppressors = [
      'Alt+Space', 'Alt+F4', 'Alt+Esc',
      'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
    ]
    for (const supAcc of systemSuppressors) {
      try {
        // 跳过已被本录制流程注册为抑制器的（含上面从 registered 替换的）
        if (this._recordingSuppressors.includes(supAcc)) continue
        // 跳过已被其他应用/进程注册的
        if (globalShortcut.isRegistered(supAcc)) continue
        const ok = globalShortcut.register(supAcc, () => {})
        if (ok) this._recordingSuppressors.push(supAcc)
      } catch {
        // ignore
      }
    }

    return true
  }

  /** 停止录制热键 */
  stopRecording(): void {
    this.restoreAfterRecording()
  }

  /**
   * 暂停所有全局热键（unregister globalShortcut + 设置 _paused 标志）。
   * 用于使用指南等窗口打开时禁用所有全局快捷键，防止 Alt+Space 等干扰。
   * registered Map 保持不变，resumeAllShortcuts() 可恢复。
   */
  pauseAllShortcuts(): void {
    if (this._paused) return
    this._paused = true
    for (const acc of this.registered.keys()) {
      try { globalShortcut.unregister(acc) } catch { /* ignore */ }
    }
    // 暂停语音热键
    if (this.voiceMatcher) {
      this.voiceKeyPressed = false
      this.stopVoicePolling()
    }
    console.log('[HotkeyManager] 所有全局热键已暂停')
  }

  /**
   * 恢复所有全局热键（重新 register globalShortcut + 清除 _paused 标志）。
   * 配合 pauseAllShortcuts() 使用。
   */
  resumeAllShortcuts(): void {
    if (!this._paused) return
    this._paused = false
    for (const [acc, cb] of this.registered) {
      try { globalShortcut.register(acc, cb) } catch { /* ignore */ }
    }
    console.log('[HotkeyManager] 所有全局热键已恢复')
  }

  /**
   * 获取热键管理器状态（用于 UI 启动状态指示）
   * - uiohookStarted: uiohook 监听是否已启动
   * - voiceHotkeyRegistered: 语音热键是否已注册
   * - voiceKeyPressed: 当前是否认为 V 键处于按下状态
   */
  getStatus(): {
    uiohookStarted: boolean
    voiceHotkeyRegistered: boolean
    voiceKeyPressed: boolean
    pollingActive: boolean
  } {
    return {
      uiohookStarted: this.uiohookStarted,
      voiceHotkeyRegistered: this.voiceMatcher !== null,
      voiceKeyPressed: this.voiceKeyPressed,
      pollingActive: this.voicePollingTimer !== null,
    }
  }
}
