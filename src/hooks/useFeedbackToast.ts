/* =====================================================================
   hooks/useFeedbackToast.ts —— 反馈消息（带自动清除）的轻量 Hook
   抽取 Section 中重复的「setFeedback + setTimeout」模式：
   - showFeedback(msg) 设置消息并在 duration 毫秒后自动清空
   - 重复调用会重置定时器，避免旧定时器提前清空新消息
   - clearFeedback() 立即清空并取消定时器
   ===================================================================== */

import { useState, useRef, useCallback } from 'react';

export interface UseFeedbackToastResult {
  /** 当前反馈消息（空字符串表示无） */
  feedback: string;
  /** 设置反馈消息，并在 duration 毫秒后自动清空 */
  showFeedback: (message: string) => void;
  /** 立即清空反馈并取消定时器 */
  clearFeedback: () => void;
}

export function useFeedbackToast(duration = 2500): UseFeedbackToastResult {
  const [feedback, setFeedback] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showFeedback = useCallback(
    (message: string) => {
      setFeedback(message);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setFeedback(''), duration);
    },
    [duration],
  );

  const clearFeedback = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setFeedback('');
  }, []);

  return { feedback, showFeedback, clearFeedback };
}
