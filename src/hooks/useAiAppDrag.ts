/* =====================================================================
   hooks/useAiAppDrag.ts —— AI 应用卡片拖拽排序 hook
   ---------------------------------------------------------------------
   用于三处 UI（AppSwitcher / BottomBar / AiAppSection）的统一拖拽排序：
   - 管理 draggingId / hoverId 状态
   - 提供 onDragStart / onDragOver / onDrop / onDragEnd 四个 handler
   - onDrop 时计算新顺序并调用 useProfileStore.reorderProfiles 持久化
     主进程广播 PROFILE_REORDERED 后由 onProfileReordered 监听器本地重排

   使用方式：
     const { draggingId, hoverId, onDragStart, onDragOver, onDrop, onDragEnd } = useAiAppDrag(profiles);
     <button draggable onDragStart={(e) => onDragStart(e, profile.id)} ...>
   ===================================================================== */

import { useState, useCallback } from 'react';
import type { Profile } from '../lib/electron-api';
import { useProfileStore } from '../store/useProfileStore';

export interface UseAiAppDragResult {
  /** 当前正在拖拽的 Profile id（null=未拖拽） */
  draggingId: string | null;
  /** 拖拽悬停目标 Profile id（null=未悬停或悬停自身） */
  hoverId: string | null;
  /** dragstart：记录拖拽 id 并设置 dataTransfer */
  onDragStart: (e: React.DragEvent, profileId: string) => void;
  /** dragover：阻止默认行为（允许 drop）并记录 hover 目标 */
  onDragOver: (e: React.DragEvent, profileId: string) => void;
  /** drop：计算新顺序并调用 store 持久化 */
  onDrop: (e: React.DragEvent, targetId: string) => void;
  /** dragend：清理状态（无论 drop 是否发生都触发） */
  onDragEnd: () => void;
}

/**
 * AI 应用拖拽排序 hook。
 * @param profiles 当前渲染的 Profile 列表（应已按 order 排序），用于计算 drop 后的新顺序
 */
export function useAiAppDrag(profiles: Profile[]): UseAiAppDragResult {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const reset = useCallback(() => {
    setDraggingId(null);
    setHoverId(null);
  }, []);

  const onDragStart = useCallback((e: React.DragEvent, profileId: string) => {
    setDraggingId(profileId);
    e.dataTransfer.effectAllowed = 'move';
    // setData 必填：某些浏览器在 dataTransfer 为空时不触发 dragover/drop 事件
    e.dataTransfer.setData('text/plain', profileId);
  }, []);

  const onDragOver = useCallback(
    (e: React.DragEvent, profileId: string) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (profileId !== draggingId) setHoverId(profileId);
    },
    [draggingId],
  );

  const onDrop = useCallback(
    async (e: React.DragEvent, targetId: string) => {
      e.preventDefault();
      const srcId = draggingId;
      reset();
      if (!srcId || srcId === targetId) return;
      // 基于 profiles 顺序计算新顺序：移除 srcId 后插入到 targetId 位置
      const orderedIds = profiles.map((p) => p.id);
      const fromIdx = orderedIds.indexOf(srcId);
      const toIdx = orderedIds.indexOf(targetId);
      if (fromIdx === -1 || toIdx === -1) return;
      orderedIds.splice(fromIdx, 1);
      orderedIds.splice(toIdx, 0, srcId);
      try {
        await useProfileStore.getState().reorderProfiles(orderedIds);
      } catch (err) {
        console.error('[useAiAppDrag] 持久化排序失败:', err);
      }
    },
    [draggingId, profiles, reset],
  );

  const onDragEnd = useCallback(() => {
    reset();
  }, [reset]);

  return { draggingId, hoverId, onDragStart, onDragOver, onDrop, onDragEnd };
}
