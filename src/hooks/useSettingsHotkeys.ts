/* =====================================================================
   hooks/useSettingsHotkeys.ts —— 设置面板：热键配置 + 设备预设 Hook
   从 useSettingsData.ts 拆分（该文件按数据域分治，热键/预设域独立成文件）；
   useSettingsData.ts 继续 re-export，消费方导入路径不变。
   ===================================================================== */

import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  getHotkeys,
  setHotkeyFor,
  setHotkeyEnabled,
  listPresets,
  listAIPlatforms,
} from '../lib/electron-api';
import type {
  DevicePreset,
  HotkeyConfig,
  HotkeyAction,
  AIPlatform,
} from '../lib/electron-api';

/* =====================================================================
   useHotkeys —— 热键配置
   ===================================================================== */

export interface HotkeysState {
  hotkeys: HotkeyConfig[];
  setHotkeys: Dispatch<SetStateAction<HotkeyConfig[]>>;
  drafts: Record<string, string>;
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  savingAction: HotkeyAction | null;
  setSavingAction: Dispatch<SetStateAction<HotkeyAction | null>>;
  feedback: Record<string, { type: 'success' | 'error'; msg: string } | null>;
  setFeedback: Dispatch<SetStateAction<Record<string, { type: 'success' | 'error'; msg: string } | null>>>;
  load: () => Promise<void>;
  saveHotkey: (action: HotkeyAction) => Promise<void>;
  toggleEnabled: (action: HotkeyAction, enabled: boolean) => Promise<void>;
}

export function useHotkeys(enabled: boolean): HotkeysState {
  const [hotkeys, setHotkeys] = useState<HotkeyConfig[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingAction, setSavingAction] = useState<HotkeyAction | null>(null);
  const [feedback, setFeedback] = useState<
    Record<string, { type: 'success' | 'error'; msg: string } | null>
  >({});

  const load = useCallback(async () => {
    try {
      const list = await getHotkeys();
      setHotkeys(list);
      const draftMap: Record<string, string> = {};
      for (const h of list) draftMap[h.action] = h.accelerator;
      setDrafts(draftMap);
      setFeedback({});
    } catch (e) {
      console.error('[useHotkeys] 加载失败:', e);
    }
  }, []);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  const saveHotkey = useCallback(
    async (action: HotkeyAction) => {
      const acc = (drafts[action] ?? '').trim();
      if (!acc) {
        setFeedback((p) => ({ ...p, [action]: { type: 'error', msg: '热键不能为空' } }));
        return;
      }
      setSavingAction(action);
      setFeedback((p) => ({ ...p, [action]: null }));
      try {
        const current = hotkeys.find((h) => h.action === action);
        if (current && !current.enabled) {
          await setHotkeyEnabled(action, true);
        }
        const ok = await setHotkeyFor(action, acc);
        if (ok) {
          setHotkeys((list) =>
            list.map((h) => (h.action === action ? { ...h, accelerator: acc, enabled: true } : h)),
          );
          setFeedback((p) => ({ ...p, [action]: { type: 'success', msg: '已保存并生效' } }));
        } else {
          const currentAcc = current?.accelerator ?? '';
          setDrafts((p) => ({ ...p, [action]: currentAcc }));
          setFeedback((p) => ({
            ...p,
            [action]: { type: 'error', msg: '注册失败（可能被其他应用占用），已恢复原热键' },
          }));
        }
      } catch (e) {
        setFeedback((p) => ({
          ...p,
          [action]: { type: 'error', msg: e instanceof Error ? e.message : String(e) },
        }));
      } finally {
        setSavingAction(null);
      }
    },
    [drafts, hotkeys],
  );

  const toggleEnabled = useCallback(
    async (action: HotkeyAction, enabled: boolean) => {
      setSavingAction(action);
      try {
        await setHotkeyEnabled(action, enabled);
        setHotkeys((list) => list.map((h) => (h.action === action ? { ...h, enabled } : h)));
        setFeedback((p) => ({
          ...p,
          [action]: { type: 'success', msg: enabled ? '已启用' : '已禁用' },
        }));
      } catch (e) {
        setFeedback((p) => ({
          ...p,
          [action]: { type: 'error', msg: e instanceof Error ? e.message : String(e) },
        }));
      } finally {
        setSavingAction(null);
      }
    },
    [],
  );

  return {
    hotkeys, setHotkeys,
    drafts, setDrafts,
    savingAction, setSavingAction,
    feedback, setFeedback,
    load,
    saveHotkey,
    toggleEnabled,
  };
}

/* =====================================================================
   usePresets —— 设备预设 + AI 平台列表
   ===================================================================== */

export interface PresetsState {
  presets: DevicePreset[];
  setPresets: Dispatch<SetStateAction<DevicePreset[]>>;
  isLoading: boolean;
  platforms: AIPlatform[];
  setPlatforms: Dispatch<SetStateAction<AIPlatform[]>>;
  load: () => Promise<void>;
}

export function usePresets(enabled: boolean): PresetsState {
  const [presets, setPresets] = useState<DevicePreset[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [platforms, setPlatforms] = useState<AIPlatform[]>([]);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const [presetList, platformList] = await Promise.all([listPresets(), listAIPlatforms()]);
      setPresets(presetList);
      setPlatforms(platformList);
    } catch (e) {
      console.error('[usePresets] 加载失败:', e);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled && presets.length === 0) void load();
  }, [enabled, presets.length, load]);

  return {
    presets, setPresets,
    isLoading,
    platforms, setPlatforms,
    load,
  };
}
