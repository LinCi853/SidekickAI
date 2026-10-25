import { useMemo } from 'react'
import { useRegisterShortcutDocs } from '../store/useShortcutDocStore'
import { useShortcutRegistry, type ShortcutEntry } from './useShortcutRegistry'

/**
 * 按住 `~`（物理键 Backquote）显示快捷键速览，松开立即关闭。
 * - 输入框/contenteditable 焦点时跳过（不影响正常输入）。
 * - 与主进程 before-input-event 拦截分支互补：webview 焦点时由主进程
 *   转发 openShortcuts / closeShortcuts，由组件 setOpen。
 * - 全页面统一；`?` 不再唤起。
 * - 走 useShortcutRegistry hold 语义（与长按 Tab 等同一层）。
 */
export function useShortcutsToggle(open: boolean, setOpen: (v: boolean) => void): void {
  const shortcuts = useMemo<ShortcutEntry[]>(
    () => [
      {
        accelerator: '`',
        code: 'Backquote',
        ignoreWhenTyping: true,
        onHoldStart: (e) => {
          e.preventDefault()
          setOpen(true)
        },
        onHoldEnd: (e) => {
          e.preventDefault()
          // 注册表保留按下时的结束回调，不能依赖那个时刻的打开状态。
          setOpen(false)
        },
      },
    ],
    [open, setOpen],
  )
  useShortcutRegistry(shortcuts, { capture: true, ignoreRepeat: true })

  useRegisterShortcutDocs('help-toggle', [
    { id: 'help.toggle', keys: '按住 ~', action: '显示快捷键速览（松开关闭）', category: 'page' },
  ])
}
