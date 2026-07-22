/* =====================================================================
   hooks/useSwipeNavigation.ts —— 左右滑动手势导航（M3）
   ---------------------------------------------------------------------
   返回可绑定到 React 元素的 onTouchStart / onTouchEnd 处理器。
   判定规则：水平位移 > 阈值（默认 50px）且大于垂直位移 → 触发滑动。
     - 向左滑（dx < 0）→ onSwipeLeft
     - 向右滑（dx > 0）→ onSwipeRight
   用于移动端内容区切换标签。
   ===================================================================== */

import { useRef } from 'react'

interface SwipeNavigationOptions {
  /** 向左滑回调（切换到下一个标签） */
  onSwipeLeft: () => void
  /** 向右滑回调（切换到上一个标签） */
  onSwipeRight: () => void
  /** 触发阈值（px），默认 50 */
  threshold?: number
}

/** 返回可绑定到 div 的 React touch 事件处理器 */
export function useSwipeNavigation(opts: SwipeNavigationOptions) {
  const touchStart = useRef<{ x: number; y: number } | null>(null)

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0]
    touchStart.current = { x: t.clientX, y: t.clientY }
  }

  const onTouchEnd = (e: React.TouchEvent) => {
    if (!touchStart.current) return
    const t = e.changedTouches[0]
    const dx = t.clientX - touchStart.current.x
    const dy = t.clientY - touchStart.current.y
    const th = opts.threshold ?? 50
    if (Math.abs(dx) > th && Math.abs(dx) > Math.abs(dy)) {
      if (dx > 0) opts.onSwipeRight()
      else opts.onSwipeLeft()
    }
    touchStart.current = null
  }

  return { onTouchStart, onTouchEnd }
}
