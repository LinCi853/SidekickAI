/* =====================================================================
   hooks/useGlobalHotkeyDocs.ts —— 全局热键的注册即声明
   页面打开时立即扫描主进程全局热键配置（getHotkeys + onChanged 订阅），
   把「实配键位 / 启停状态 / 动作名」注册进快捷键注册表
   （store/useShortcutDocStore），弹窗只读快照。用户在设置里改键、
   启停后本 hook 重新注册，弹窗即时反映（禁用项灰显）。

   说明文字在本注册点声明：GLOBAL_HOTKEY_META 的 actionText / note 为
   回退文案（配置未加载时使用），运行时以主进程 HotkeyConfig.label 为准；
   toggleVoice / toggleAiAssets 等未列元信息但已配置键位的动作按配置追加。
   ===================================================================== */

import { useEffect, useState } from 'react';
import { getHotkeys, requireElectron } from '../lib/electron-api';
import type { HotkeyConfig } from '../lib/electron-api';
import { useRegisterShortcutDocs } from '../store/useShortcutDocStore';
import type { ShortcutDoc } from '../store/useShortcutDocStore';
import { GLOBAL_HOTKEY_META, formatAcc } from '../lib/shortcut-reference';

function buildGlobalDocs(hotkeys: HotkeyConfig[]): ShortcutDoc[] {
  const docs: ShortcutDoc[] = GLOBAL_HOTKEY_META.map((meta) => {
    const cfg = hotkeys.find((h) => h.action === meta.action);
    return {
      id: `global.${meta.action}`,
      keys: cfg?.accelerator ? formatAcc(cfg.accelerator) : meta.fallbackKeys,
      action: meta.actionText,
      category: 'global',
      note: meta.note,
      disabled: cfg ? !cfg.enabled : false,
    };
  });
  const listed = new Set(GLOBAL_HOTKEY_META.map((m) => m.action));
  for (const cfg of hotkeys) {
    if (listed.has(cfg.action) || !cfg.accelerator) continue;
    docs.push({
      id: `global.${cfg.action}`,
      keys: formatAcc(cfg.accelerator),
      action: cfg.label,
      category: 'global',
      disabled: !cfg.enabled,
    });
  }
  return docs;
}

export function useGlobalHotkeyDocs(): void {
  const [hotkeys, setHotkeys] = useState<HotkeyConfig[]>([]);

  useEffect(() => {
    let cancelled = false;
    void getHotkeys()
      .then((list) => { if (!cancelled) setHotkeys(list); })
      .catch((e) => console.warn('[global-hotkey-docs] 加载全局热键失败:', e));
    let off: (() => void) | undefined;
    try {
      off = requireElectron().hotkey.onChanged((list) => setHotkeys(list));
    } catch {
      // preload 未就绪或测试环境：仅保留一次性加载结果
    }
    return () => { cancelled = true; off?.(); };
  }, []);

  useRegisterShortcutDocs('global-hotkeys', buildGlobalDocs(hotkeys));
}
