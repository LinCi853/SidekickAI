// electron/ipc/hotkey-ipc.ts — 热键相关 IPC 注册 + 内置热键回调注册
//
// 包含：
//   - 热键 CRUD（HOTKEY_REGISTER / HOTKEY_UNREGISTER / HOTKEY_IS_REGISTERED / HOTKEY_GET_ALL / HOTKEY_SET）
//   - 内置热键回调（toggleMainWindow / toggleDetachedWindows / backgroundVoice 占位）
//   - registerDefaultShortcuts：注册 2 个默认内置热键（从持久化配置读取 accelerator）
//   - registerVoiceHotkey：注册 Alt+V 后台语音热键（hold-to-record，仅 uiohook keydown/keyup）
//     统一走主进程 SttEngine + 预览窗 + IPC 注入+发送 路径，
//     语音 UI 始终为独立预览窗（PreviewView），不再使用内嵌浮层。
//
// hotkeyCallbacks（原 main.ts 全局变量）迁移到本文件内部，仅 HOTKEY_SET 与默认热键注册使用。
// 在 app.whenReady 后由 main.ts 调用 registerHotkeyIpc(deps) 完成注册。
//
// 已迁移到统一注入管线：支持 EffectScope 管理 IPC handler 生命周期。

import { ipcMain, type BrowserWindow } from 'electron'
import type { EffectScope } from '../modules/effect-scope.js'
import { IPC_CHANNELS, type HotkeyAction } from '../shared/types.js'
import { isModuleEnabled } from '../modules/registry.js'
import { syncVoiceHotkeyRegistration } from '../modules/wiring/voice.js'
import {
  setAdvancedPanelAvailability,
  setAdvancedPanelCallback,
  setBrowserAvailability,
  syncAdvancedPanelHotkey,
  syncBrowserProfileShortcuts,
} from '../modules/wiring/hotkey-sync.js'
import type { HotkeyManager } from '../hotkey/manager.js'
import { resetMainWindowToDefault } from '../window-factory/main-window.js'
import { getAppSettings } from '../store/app-settings-store.js'
import * as focusManager from '../utils/focus-manager.js'

/** 由 main.ts 注入的依赖（避免循环引用） */
export interface HotkeyIpcDeps {
  hotkeyManager: HotkeyManager
  /** 获取主窗口（实时读取，等价于原全局变量 mainWindow 的闭包访问） */
  getMainWindow: () => BrowserWindow | null
  /** 进阶面板显隐切换（Alt+Q，单例） */
  toggleAdvancedPanelWindow: () => void
  /** 启动后台语音录音（Alt+V keydown，主窗口未聚焦时调用） */
  startBackgroundVoice: () => Promise<void>
  /** 停止后台语音录音并识别（Alt+V keyup） */
  stopBackgroundVoice: () => Promise<void>
  /** 切换语音录音状态（按下开始，再按停止） */
  toggleVoiceRecording: () => Promise<void>
}

/** 连续 Alt+Space 触发计数（防误触恢复默认窗口位置）
 *  时间窗口随阈值线性放大（每次 500ms，最小 1500ms），阈值从 AppSettings 读取 */
let altSpaceTriggerTimes: number[] = []

/**
 * 注册热键相关 IPC handler + 内置热键。
 *
 * 已迁移到统一注入管线：支持 EffectScope 管理 IPC handler 生命周期。
 */
export function registerHotkeyIpc(deps: HotkeyIpcDeps, scope?: EffectScope): void {
  const {
    hotkeyManager,
    getMainWindow,
    toggleAdvancedPanelWindow,
    startBackgroundVoice,
    stopBackgroundVoice,
    toggleVoiceRecording,
  } = deps

  // 辅助函数：根据是否有 scope 选择注册方式
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = scope
    ? (channel: string, fn: (...args: any[]) => any) => scope.ipcHandle(channel, fn as any)
    : (channel: string, fn: (...args: any[]) => any) => ipcMain.handle(channel, fn as any)

  // ===== 内置热键回调 =====
  // toggleMainWindow：切换主窗口显隐；连续 3 次 Alt+Space 恢复默认窗口位置
  // toggleDetachedWindows：切换 进阶面板显隐（Alt+Q，单例）
  // 声明在 IPC 注册之前：HOTKEY_SET handler 闭包引用此对象，运行时已初始化。
  const hotkeyCallbacks: Record<HotkeyAction, () => void> = {
    toggleMainWindow: () => {
      const now = Date.now()
      // 从 AppSettings 动态读取阈值，时间窗口随阈值线性放大
      const { altSpaceResetThreshold } = getAppSettings()
      const windowMs = Math.max(1500, altSpaceResetThreshold * 500)
      // 清理超过时间窗口的旧记录
      altSpaceTriggerTimes = altSpaceTriggerTimes.filter(
        (t) => now - t < windowMs,
      )
      altSpaceTriggerTimes.push(now)

      // 连续达到阈值次 Alt+Space：恢复默认窗口位置和大小（防误触）
      if (altSpaceTriggerTimes.length >= altSpaceResetThreshold) {
        altSpaceTriggerTimes = []
        resetMainWindowToDefault()
        return
      }

      // 正常切换显隐
      const mainWindow = getMainWindow()
      if (!mainWindow) return
      if (!mainWindow.isVisible() || mainWindow.isMinimized()) {
        // 显示：同步 show + focus（立即生效）
        focusManager.show(mainWindow)
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_CHANNELS.WINDOW_SHOWN)
        }
      } else if (!mainWindow.isFocused()) {
        mainWindow.focus()
        mainWindow.webContents.send(IPC_CHANNELS.WINDOW_SHOWN)
      } else {
        // 隐藏：hide + 异步恢复外部窗口（不阻塞主进程）
        focusManager.hide(mainWindow)
      }
    },
    toggleDetachedWindows: () => {
      // Alt+Q 切换 进阶面板；无可用 tab 模块时已由 hotkey-sync 注销，此处兜底守卫
      if (!isModuleEnabled('custom-chat') && !isModuleEnabled('whiteboard') && !isModuleEnabled('notes')) return
      toggleAdvancedPanelWindow()
    },
    // backgroundVoice 由 registerVoiceHotkey 独立处理（uiohook keydown/keyup），
    // 此处仅占位以满足 Record<HotkeyAction, () => void> 类型；HOTKEY_SET 拒绝自定义。
    backgroundVoice: () => {},
    // toggleVoice：按一下开始录音，再按一下停止录音并识别
    toggleVoice: () => {
      void toggleVoiceRecording()
    },
  }

  // ===== 热键 CRUD IPC =====
  handle(IPC_CHANNELS.HOTKEY_REGISTER, async (_e: unknown, accelerator: string) => {
    return hotkeyManager.register(accelerator, () => {
      getMainWindow()?.webContents.send(IPC_CHANNELS.HOTKEY_TRIGGERED, accelerator)
    })
  })
  handle(IPC_CHANNELS.HOTKEY_UNREGISTER, async (_e: unknown, accelerator: string) => {
    hotkeyManager.unregister(accelerator)
  })
  handle(IPC_CHANNELS.HOTKEY_IS_REGISTERED, async (_e: unknown, accelerator: string) => {
    return hotkeyManager.isRegistered(accelerator)
  })
  handle(IPC_CHANNELS.HOTKEY_GET_ALL, async () => {
    return hotkeyManager.getAllHotkeys()
  })
  handle(IPC_CHANNELS.HOTKEY_SET, async (_e: unknown, action: HotkeyAction, accelerator: string) => {
    // backgroundVoice 走 uiohook keydown/keyup 独立路径（不支持 globalShortcut）
    if (action === 'backgroundVoice') {
      // 注销旧语音热键
      hotkeyManager.voiceUnregisterFn?.()
      // 注册新语音热键并保存注销函数
      hotkeyManager.voiceUnregisterFn = hotkeyManager.registerVoiceHotkey(
        accelerator,
        () => {
          void startBackgroundVoice()
        },
        () => {
          void stopBackgroundVoice()
        },
      )
      // 持久化 + 更新映射
      hotkeyManager.setHotkey('backgroundVoice', accelerator)
      hotkeyManager.recordActionAccelerator('backgroundVoice', accelerator)
      // 若热键当前被禁用，保存时自动启用（用户编辑热键即表示想使用它）
      if (!hotkeyManager.getEnabled('backgroundVoice')) {
        hotkeyManager.setEnabled('backgroundVoice', true)
      }
      console.log(`[main] backgroundVoice 热键已更新为 ${accelerator}`)
      return true
    }

    // 普通 globalShortcut 路径
    const oldAcc = hotkeyManager.getActionAccelerator(action)
    // 先注销旧热键（仅当当前启用时才已注册，无需判断 enabled）
    hotkeyManager.unregister(oldAcc)
    const cb = hotkeyCallbacks[action]
    const ok = await hotkeyManager.register(accelerator, cb)
    if (ok) {
      // 成功：持久化 + 更新已注册映射
      hotkeyManager.setHotkey(action, accelerator)
      hotkeyManager.recordActionAccelerator(action, accelerator)
      // 若热键当前被禁用，保存时自动启用
      if (!hotkeyManager.getEnabled(action)) {
        hotkeyManager.setEnabled(action, true)
      }
    } else {
      // 失败：恢复旧热键（避免该动作彻底失效）
      await hotkeyManager.register(oldAcc, cb)
      hotkeyManager.recordActionAccelerator(action, oldAcc)
    }
    return ok
  })

  // 启用/禁用某个内置热键（独立开关）
  handle(
    IPC_CHANNELS.HOTKEY_SET_ENABLED,
    async (_e: unknown, action: HotkeyAction, enabled: boolean) => {
      const prevEnabled = hotkeyManager.getEnabled(action)
      if (prevEnabled === enabled) return // 无变化

      // 语音模块关闭时禁止启用语音热键（11.10 全路径封死）
      if (action === 'backgroundVoice' && enabled && !isModuleEnabled('voice')) {
        console.warn('[hotkey-ipc] 语音模块未启用，拒绝启用 backgroundVoice 热键')
        return
      }

      if (enabled) {
        // 从禁用切到启用：注册当前 accelerator
        const acc = hotkeyManager.getHotkey(action)
        if (action === 'backgroundVoice') {
          hotkeyManager.voiceUnregisterFn = hotkeyManager.registerVoiceHotkey(
            acc,
            () => {
              void startBackgroundVoice()
            },
            () => {
              void stopBackgroundVoice()
            },
          )
        } else {
          const cb = hotkeyCallbacks[action]
          const ok = await hotkeyManager.register(acc, cb)
          if (ok) hotkeyManager.recordActionAccelerator(action, acc)
        }
      } else {
        // 从启用切到禁用：注销当前 accelerator
        if (action === 'backgroundVoice') {
          hotkeyManager.voiceUnregisterFn?.()
          hotkeyManager.voiceUnregisterFn = null
        } else {
          const acc = hotkeyManager.getActionAccelerator(action)
          hotkeyManager.unregister(acc)
        }
      }
      // 持久化启用状态
      hotkeyManager.setEnabled(action, enabled)
      console.log(`[main] ${action} 热键已${enabled ? '启用' : '禁用'}`)
    },
  )

  // 热键录制（uiohook 系统级键盘钩子捕获，解决 Alt+key 被系统拦截的问题）
  // 录制结果只发给发起录制的窗口（sender），支持使用指南等独立窗口
  handle(IPC_CHANNELS.HOTKEY_START_RECORDING, async (event: any) => {
    const sender = event.sender
    return hotkeyManager.startRecording(
      (result) => {
        if (!sender.isDestroyed()) {
          sender.send(IPC_CHANNELS.HOTKEY_START_RECORDING, result)
        }
      },
      (partial) => {
        if (!sender.isDestroyed()) {
          sender.send(IPC_CHANNELS.HOTKEY_RECORDING_PARTIAL, partial)
        }
      },
    )
  })
  handle(IPC_CHANNELS.HOTKEY_STOP_RECORDING, async () => {
    hotkeyManager.stopRecording()
  })

  // 模块 → 热键自动同步：注入可用性判断与回调
  setAdvancedPanelAvailability(
    () => isModuleEnabled('custom-chat') || isModuleEnabled('whiteboard') || isModuleEnabled('notes'),
  )
  setAdvancedPanelCallback(() => toggleAdvancedPanelWindow())
  setBrowserAvailability(() => isModuleEnabled('browser'))

  // 注册 2 个默认内置热键（从持久化配置读取 accelerator）
  void hotkeyManager.registerDefaultShortcuts(hotkeyCallbacks)

  // 进阶面板无可用模块时自动注销 Alt+Q
  syncAdvancedPanelHotkey()

  // 启动时注册所有 Profile 的浏览器窗口脱离/回归快捷键（浏览器模块关闭时自动跳过/注销）
  void syncBrowserProfileShortcuts()

  // 注册 Alt+V 后台语音热键：由 wiring/voice.syncVoiceHotkeyRegistration 统一处理
  // （内部检查语音模块状态 + backgroundVoice 开关，幂等，避免双注册）
  syncVoiceHotkeyRegistration()
}
