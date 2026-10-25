// electron/ipc/profile-shortcut-ipc.ts — Profile 浏览器窗口快捷键重注册
//
// 从 app-settings-store 拆出：hotkey-sync 启动同步与设置 IPC 共用的注册入口。
// 动态导入 browser 域模块，避免在模块加载期引入窗口/存储依赖。

import { getHotkeyManagerInstance } from '../platform/hotkey/manager.js'

/**
 * 重新注册所有 Profile 的浏览器窗口脱离/回归快捷键。
 *
 * 遍历所有 Profile，注册非空 browserWindowShortcut（accelerator 字符串）到系统 globalShortcut。
 * 触发时调用 toggleBrowserWindow(profileId) 脱离/回归对应应用的浏览器窗口
 * （已打开则回归关闭、未打开则脱离主窗口标签迁出）。
 *
 * 设计要点：
 * - 按 accelerator 去重避免同一组合键被多次注册（先到先得）
 * - 默认无快捷键（Profile.browserWindowShortcut 为 undefined 时不注册）
 * - 全部为系统级全局快捷键（应用未聚焦也生效）
 */
export async function reregisterProfileShortcuts(): Promise<void> {
  const mgr = getHotkeyManagerInstance()
  if (!mgr) return

  // 1. 注销所有旧的浏览器全局快捷键
  mgr.unregisterAllBrowserShortcuts()

  // 2. 收集所有 Profile 的快捷键（按 accelerator 去重，先到先得）
  const seen = new Set<string>()
  const toRegister: Array<{ accelerator: string; profileId: string }> = []

  try {
    const { profileStore } = await import('../browser/profile-store.js')
    for (const profile of profileStore.list()) {
      const acc = profile.browserWindowShortcut
      if (!acc) continue
      if (seen.has(acc)) {
        console.warn(
          `[reregisterProfileShortcuts] 快捷键 ${acc} 已被其他应用占用，跳过 Profile ${profile.id}（${profile.name}）`,
        )
        continue
      }
      seen.add(acc)
      toRegister.push({ accelerator: acc, profileId: profile.id })
    }
  } catch (err) {
    console.warn('[reregisterProfileShortcuts] 读取 profileStore 失败:', err)
    return
  }

  // 3. 注册新的全局快捷键
  for (const { accelerator, profileId } of toRegister) {
    mgr.registerBrowserShortcut(accelerator, () => {
      // ESM 环境中 require 未定义,使用动态 import() 避免闪退
      import('../browser/browser-window.js')
        .then(({ toggleBrowserWindow }) => {
          toggleBrowserWindow(profileId)
        })
        .catch((e) => {
          console.error('[reregisterProfileShortcuts] 动态导入失败:', e)
        })
    })
  }
}
