import { useCallback } from 'react'
import { useTabStore } from '@/store/useTabStore'

/**
 * 迁回主窗口 + 聚焦 AI 输入框的通用 hook
 * 所有返回主界面的操作均触发
 */
export function useMigrateBackAndFocus() {
  const triggerFocusAiInput = useTabStore((s) => s.triggerFocusAiInput)

  return useCallback(() => {
    // 触发主窗口 AI 输入框聚焦
    triggerFocusAiInput()
  }, [triggerFocusAiInput])
}
