// electron/utils/ask-save-path.ts — 「另存为」下载标记
//
// 右键「链接另存为... / 图片另存为...」时，渲染层通过 BROWSER_DOWNLOAD_AS IPC
// 触发 session.downloadURL(url)，并在本模块登记一次「另存为」标记。
// will-download（browser-window.ts）消费标记后弹出保存对话框，让用户选择路径，
// 而不是静默保存到默认下载目录。
//
// 一次性语义：每次下载仅生效一次，避免影响后续普通下载。

/** 待处理的「另存为」下载计数（session 级，与具体 webContents 解耦） */
let pendingAskSavePath = 0

/** 登记一次「另存为」下载 */
export function markAskSavePath(): void {
  pendingAskSavePath += 1
}

/**
 * 消费一次「另存为」标记（will-download 中调用）。
 * @returns 是否为「另存为」下载（消费后计数减一，仅生效一次）
 */
export function consumeAskSavePath(): boolean {
  if (pendingAskSavePath <= 0) return false
  pendingAskSavePath -= 1
  return true
}
