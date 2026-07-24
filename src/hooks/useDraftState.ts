import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

interface UseDraftStateOptions<T> {
  /** 初始值（通常是 props 传入的当前持久化值） */
  initial: T;
  /** 保存回调；成功后不自动 reset，由调用方 / props 更新决定 */
  onSave: (draft: T) => Promise<void> | void;
  /** 可选校验：返回 false 时 save 直接返回，不调用 onSave */
  validate?: (draft: T) => boolean;
}

interface UseDraftStateResult<T> {
  draft: T;
  setDraft: Dispatch<SetStateAction<T>>;
  isDirty: boolean;
  save: () => Promise<void>;
  reset: () => void;
}

/** 序列化用于深比较（草稿均为可 JSON 化的扁平对象 / 基本类型） */
function serialize<T>(value: T): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 通用草稿状态 hook：统一管理「编辑中的值 / dirty 判断 / 保存 / 重置 / props 同步」。
 *
 * 同步策略（与 SettingsPanel 各 section 历史行为一致，并修正「props 异步加载后表单不刷新」问题）：
 * - 当 initial 真正发生变化（按值比较）时同步 draft；
 * - 但若用户已编辑（draft 与上一次 initial 不一致），则保留 draft，避免打断输入；
 * - 保存成功后不自动 reset：调用方通常在 onSave 中把持久化值写回父级 state，
 *   initial 随之更新，draft 自然与新 initial 一致（isDirty 归零）。
 */
export function useDraftState<T>(opts: UseDraftStateOptions<T>): UseDraftStateResult<T> {
  const { initial, onSave, validate } = opts;
  const [draft, setDraft] = useState<T>(initial);

  const isDirty = useMemo(() => serialize(draft) !== serialize(initial), [draft, initial]);

  // 跟踪上一次 initial 的序列化值，仅在 initial 真正变化时尝试同步
  const prevInitialKeyRef = useRef<string>(serialize(initial));
  useEffect(() => {
    const nextKey = serialize(initial);
    if (nextKey === prevInitialKeyRef.current) return;
    // initial 已变化：仅在用户未编辑（draft 仍等于上一次 initial）时同步
    setDraft((prev) => {
      if (serialize(prev) === prevInitialKeyRef.current) {
        return initial;
      }
      return prev;
    });
    prevInitialKeyRef.current = nextKey;
  }, [initial]);

  const save = async () => {
    if (validate && !validate(draft)) return;
    await onSave(draft);
  };

  const reset = () => {
    setDraft(initial);
  };

  return { draft, setDraft, isDirty, save, reset };
}
