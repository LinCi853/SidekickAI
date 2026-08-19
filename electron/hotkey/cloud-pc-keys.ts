// electron/hotkey/cloud-pc-keys.ts — 云电脑模式系统级按键分类（Windows VK 码）

/** Windows 虚拟键码 */
const VK_TAB = 9
const VK_F4 = 115
const VK_ESCAPE = 27
const VK_D = 68
const VK_LWIN = 91
const VK_RWIN = 92

/**
 * 把 uiohook 的 keycode 分类为云电脑需路由的系统级按键。
 * @returns 按键名（meta/alt/tab/d/f4）或 null（无需路由）
 */
export function classifyCloudPcKey(
  keycode: number,
  altKey: boolean,
  winDown: boolean,
  ctrlDown: boolean,
): string | null {
  if (keycode === VK_LWIN || keycode === VK_RWIN) return 'meta'
  if (keycode === VK_TAB && (altKey || winDown)) return 'tab'
  if (keycode === VK_D && winDown && !ctrlDown) return 'd'
  if (keycode === VK_F4 && altKey) return 'f4'
  if (keycode === VK_ESCAPE) return 'escape'
  return null
}
