import { BrowserWindow } from 'electron'

/**
 * 向所有 BrowserWindow 的渲染层广播 IPC 消息。
 *
 * 跳过已销毁的窗口；单次发送失败仅告警，不中断后续窗口的广播。
 *
 * @param channel IPC 频道名
 * @param payload 载荷（与渲染层监听器的签名一致）
 * @param label   可选标签，用于失败日志中区分调用来源（如 'profile'、'app-settings'）
 */
export function broadcastToAllWindows(channel: string, payload: unknown, label?: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send(channel, payload)
    } catch (err) {
      console.warn(`[broadcast${label ? ':' + label : ''}] 发送失败:`, err)
    }
  }
}
