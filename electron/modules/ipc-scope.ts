// electron/modules/ipc-scope.ts — 模块 IPC 注册作用域（零残留卸载）
//
// 每个模块的 wiring 持有自己的 IpcScope：init 时登记通道，dispose 时统一
// removeHandler + removeAllListeners。通道清单与注册点同文件维护（单一事实源）。
//
// 注：模块各自的 registerXxx 函数仍直接调 ipcMain（历史实现），wiring 在
// init 前用 scope.track(...) 登记这些通道，保证 teardown 能精确卸载。

import { ipcMain } from 'electron'

export class IpcScope {
  private readonly channels = new Set<string>()

  constructor(readonly label: string) {}

  /** 登记通道（供 dispose 卸载；重复登记幂等） */
  track(...channels: string[]): void {
    for (const ch of channels) this.channels.add(ch)
  }

  /** 直接经作用域注册 handle（新模块建议用此方式，天然可卸载） */
  handle(channel: string, fn: Parameters<typeof ipcMain.handle>[1]): void {
    ipcMain.handle(channel, fn)
    this.channels.add(channel)
  }

  /** 直接经作用域注册 on（新模块建议用此方式，天然可卸载） */
  on(channel: string, fn: Parameters<typeof ipcMain.on>[1]): void {
    ipcMain.on(channel, fn)
    this.channels.add(channel)
  }

  /** 卸载全部登记通道（removeHandler + removeAllListeners 双保险） */
  dispose(): void {
    for (const ch of this.channels) {
      ipcMain.removeHandler(ch)
      ipcMain.removeAllListeners(ch)
    }
    const n = this.channels.size
    this.channels.clear()
    console.log(`[ipc-scope:${this.label}] 已卸载 ${n} 个通道`)
  }
}
