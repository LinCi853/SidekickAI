/* =====================================================================
   components/ShortcutHelp.tsx —— 自包含快捷键说明入口（所有页面通用）
   一行接入：<ShortcutHelp />（非受控）或
   <ShortcutHelp open={open} onOpenChange={setOpen} />（受控，页面已有
   按钮/状态时使用，如主窗口底栏按钮、独立窗口顶栏图标）。

   呼出通道（两类互补，覆盖所有焦点场景；按住 ~ 显示、松开关闭）：
   1. 窗口焦点：useShortcutsToggle 监听 Backquote 的 keydown/keyup
   2. webview 焦点：主进程 before-input-event 拦截后转发 openShortcuts / closeShortcuts，
      useOpenShortcutsForward 接住
   页面 UI 按钮：受控模式由页面直接 setOpen(true/false)

   数据准备：挂载即扫描全局热键（useGlobalHotkeyDocs）并连同各行为 hook
   注册进快捷键注册表（store/useShortcutDocStore）——页面打开时数据已备好，
   弹窗只读快照。
   ===================================================================== */

import { useCallback, useState } from 'react'
import ShortcutsModal from './ShortcutsModal'
import { useShortcutsToggle } from '../hooks/useShortcutsToggle'
import { useOpenShortcutsForward } from '../hooks/useOpenShortcutsForward'
import { useGlobalHotkeyDocs } from '../hooks/useGlobalHotkeyDocs'

export interface ShortcutHelpProps {
  /** 受控打开状态（与 onOpenChange 成对传入；缺省为组件内部状态） */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export default function ShortcutHelp({ open, onOpenChange }: ShortcutHelpProps) {
  const controlled = typeof open === 'boolean' && typeof onOpenChange === 'function'
  const [internalOpen, setInternalOpen] = useState(false)
  const isOpen = controlled ? (open as boolean) : internalOpen

  const setOpen = useCallback(
    (value: boolean) => {
      if (controlled) onOpenChange?.(value)
      else setInternalOpen(value)
    },
    [controlled, onOpenChange],
  )

  useGlobalHotkeyDocs()
  useShortcutsToggle(isOpen, setOpen)
  useOpenShortcutsForward(
    () => setOpen(true),
    () => setOpen(false),
  )

  return <ShortcutsModal open={isOpen} onClose={() => setOpen(false)} />
}
