/* =====================================================================
   hooks/usePromptHotkeys.ts —— 提示词局内快捷键 Hook（需求 2.5）
   - 监听 window keydown 事件
   - 将 KeyboardEvent 归一化为 accelerator 字符串
   - 在 prompt 列表中查找匹配的模板，调用 onTriggered 回调
   - 冲突检测：注册时对比应用快捷键，冲突的 prompt 跳过并记录警告日志
   - 在输入框/文本域中不触发（避免影响用户输入）
   ===================================================================== */

import { useEffect, useRef } from 'react';
import { usePromptStore } from '../store/usePromptStore';
import { getHotkeys } from '../lib/electron-api';
import { keyEventToAccelerator, detectPromptHotkeyConflicts } from '../lib/prompt-hotkey';
import { isTypingTarget } from '../lib/shared-utils';
import type { PromptTemplate } from '../lib/electron-api';

export interface UsePromptHotkeysOptions {
  /** 命中快捷键时调用（传入匹配的 prompt 模板）
   *  options.skipPreview: true 表示用户在 800ms 内连续按两次同一快捷键，跳过预览直接注入
   */
  onTriggered: (template: PromptTemplate, options?: { skipPreview?: boolean }) => void;
}

/**
 * 提示词局内快捷键 Hook
 *
 * 在 MainView 中注册：监听 window keydown 事件，匹配 prompt.hotkey 字段。
 * 冲突检测：与应用内置快捷键（Alt+1~9、Ctrl+Tab 等）和主进程全局热键对比，
 * 冲突的 prompt 快捷键被跳过并记录警告日志。
 */
export function usePromptHotkeys({ onTriggered }: UsePromptHotkeysOptions): void {
  // 最新的 onTriggered 回调（避免依赖变化导致频繁重注册监听器）
  const onTriggeredRef = useRef(onTriggered);
  onTriggeredRef.current = onTriggered;

  // 最新的 accelerator → prompt 映射（避免闭包过期）
  const hotkeyMapRef = useRef<Map<string, PromptTemplate>>(new Map());

  // 上次触发的 promptId 和时间戳，用于检测"双击跳过预览"
  // 800ms 内同一 prompt 快捷键按两次 → 第二次跳过预览直接注入
  const lastTriggerRef = useRef<{ promptId: string; time: number } | null>(null);

  useEffect(() => {
    let cancelled = false;

    const rebuildMap = async () => {
      const prompts = usePromptStore.getState().prompts;
      // 拉取主进程全局热键用于冲突检测
      let appHotkeys: Awaited<ReturnType<typeof getHotkeys>> = [];
      try {
        appHotkeys = await getHotkeys();
      } catch (e) {
        console.warn('[usePromptHotkeys] 加载全局热键失败，跳过冲突检测:', e);
      }
      if (cancelled) return;

      const conflicts = detectPromptHotkeyConflicts(prompts, appHotkeys);
      for (const [, msg] of conflicts) {
        console.warn(`[usePromptHotkeys] ${msg}`);
      }

      const map = new Map<string, PromptTemplate>();
      for (const p of prompts) {
        if (!p.hotkey) continue;
        if (conflicts.has(p.id)) continue; // 跳过冲突的
        map.set(p.hotkey, p);
      }
      hotkeyMapRef.current = map;
    };

    void rebuildMap();

    // 订阅 prompt store 变化
    const unsub = usePromptStore.subscribe(() => {
      void rebuildMap();
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 在输入框/文本域/contenteditable 中不触发
      if (isTypingTarget(e.target)) return;
      const acc = keyEventToAccelerator(e);
      if (!acc) return;
      const matched = hotkeyMapRef.current.get(acc);
      if (matched) {
        e.preventDefault();
        e.stopPropagation();
        // 双击跳过预览：800ms 内同一 prompt 快捷键按两次，第二次直接注入不弹预览
        const now = Date.now();
        const last = lastTriggerRef.current;
        if (last && last.promptId === matched.id && now - last.time < 800) {
          // 第二次触发：跳过预览，并清除 lastTrigger
          lastTriggerRef.current = null;
          onTriggeredRef.current(matched, { skipPreview: true });
        } else {
          // 第一次触发：记录时间戳，正常弹预览
          lastTriggerRef.current = { promptId: matched.id, time: now };
          onTriggeredRef.current(matched, { skipPreview: false });
        }
      }
    };
    // 使用捕获阶段，确保在 webview 等子元素之前拦截
    window.addEventListener('keydown', handler, true);
    return () => {
      window.removeEventListener('keydown', handler, true);
    };
  }, []);
}
