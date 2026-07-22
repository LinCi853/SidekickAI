// electron/notify.ts — 系统通知工具
//
// 封装 Electron Notification，供主进程各模块（ai/handler、stt/engine、main）统一调用。
// 通知由主进程发起，渲染层无需改动。Notification.isSupported() 为 false 时静默降级到 console.log。

import { Notification } from 'electron'

/**
 * 显示系统通知。标题+正文，默认发声（提醒）。
 * 不支持的平台上降级为 console.log，绝不抛错。
 */
export function showNotification(title: string, body: string): void {
  try {
    if (!Notification.isSupported()) {
      console.log(`[通知] ${title}: ${body}`)
      return
    }
    const n = new Notification({
      title,
      body,
      silent: false,
    })
    n.on('click', () => {
      try {
        n.close()
      } catch {
        // ignore
      }
    })
    n.show()
  } catch (err) {
    console.error('[notify] 显示通知失败:', err)
  }
}
