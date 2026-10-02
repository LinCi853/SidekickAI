import { useEffect, useState } from 'react';
import { Button } from './ui';
import { requireElectron } from '../lib/electron-api/core';
import { useAssetSettings } from '../hooks/useAssetSettings';
import { useModuleStore } from '../store/useModuleStore';
import { ASSET_SHORTCUT_LABELS } from '../../electron/shared/asset-settings';
import type { AssetCleanupRecord } from '../../electron/shared/ai-assets.types';
import type { HotkeyConfig } from '../../electron/shared/types';
import AssetFreezeControl from '../pages/ai-assets/AssetFreezeControl';
import './AssetSettingsPanel.css';

export default function AssetSettingsPanel({ freezeTarget }: { freezeTarget?: { tabId: string; revision: number } }) {
  const api = requireElectron();
  const { settings, update, error: settingsError } = useAssetSettings();
  const [hotkey, setHotkey] = useState<HotkeyConfig>();
  const [globalDraft, setGlobalDraft] = useState('');
  const [drafts, setDrafts] = useState(settings.localShortcuts);
  const [error, setError] = useState('');
  const [audits, setAudits] = useState<AssetCleanupRecord[]>([]);
  const freezeEnabled = useModuleStore(state => state.isEnabled('freeze'));
  useEffect(() => { setDrafts(settings.localShortcuts); }, [settings.localShortcuts]);
  useEffect(() => {
    let active = true;
    const apply = (values: HotkeyConfig[]) => { if (!active) return; const value = values.find(item => item.action === 'toggleAiAssets'); setHotkey(value); setGlobalDraft(value?.accelerator ?? ''); };
    const off = api.hotkey.onChanged(apply);
    void api.hotkey.getAll().then(apply).catch(failure => setError(String(failure)));
    return () => { active = false; off(); };
  }, [api]);
  const run = async (operation: () => Promise<unknown>) => { setError(''); try { await operation(); } catch (failure) { setError(String(failure)); } };
  return <div className="asset-settings" data-name="assets.settings">
    {(error || settingsError) && <p role="alert" className="asset-error">{error || settingsError}</p>}
    <label>对话排序 <select aria-label="对话排序" value={settings.sort} onChange={event => void update({ sort: event.target.value as typeof settings.sort })}>
      <option value="recent">最近更新</option><option value="views">浏览次数</option></select></label>
    <label><input type="checkbox" checked={settings.expandReasoning} onChange={event => void update({ expandReasoning: event.target.checked })} />默认展开思考</label>
    <label>修订显示 <select aria-label="修订显示" value={settings.revisionDisplay} onChange={event => void update({ revisionDisplay: event.target.value as typeof settings.revisionDisplay })}>
      <option value="history">完整历史</option><option value="diff">修订差异</option></select></label>
    <fieldset><legend>全局快捷键</legend><label>打开／关闭 AI资产 <input aria-label="打开／关闭 AI资产快捷键" placeholder="未绑定" value={globalDraft} onChange={event => setGlobalDraft(event.target.value)} /></label>
      <Button variant="outline" onClick={() => void run(async () => { if (!await api.hotkey.set('toggleAiAssets', globalDraft.trim())) throw new Error('快捷键未注册，请选择其他组合'); })}>保存全局快捷键</Button>
      <label><input type="checkbox" checked={hotkey?.enabled ?? false} disabled={!hotkey?.accelerator} onChange={event => void run(() => api.hotkey.setEnabled('toggleAiAssets', event.target.checked))} />启用全局快捷键</label>
      {hotkey?.registrationReason && <p role="status">{hotkey.registrationReason}</p>}
    </fieldset>
    <fieldset><legend>AI资产窗口内快捷键</legend>
      {(Object.keys(ASSET_SHORTCUT_LABELS) as Array<keyof typeof drafts>).map(key => <label key={key}>{ASSET_SHORTCUT_LABELS[key]}<input aria-label={`${ASSET_SHORTCUT_LABELS[key]}快捷键`} value={drafts[key]} onChange={event => setDrafts({ ...drafts, [key]: event.target.value })} /></label>)}
      <Button variant="outline" onClick={() => void update({ localShortcuts: drafts })}>保存局部快捷键</Button>
    </fieldset>
    <label><input type="checkbox" checked={freezeEnabled} onChange={event => void run(async () => { const result = await useModuleStore.getState().setEnabled('freeze', event.target.checked); if (!result.ok) throw new Error(result.error); })} />启用页面冻结</label>
    {freezeEnabled && <AssetFreezeControl target={freezeTarget} onAction={operation => void run(operation)} />}
    <details onToggle={event => { if (event.currentTarget.open) void run(async () => setAudits(await api.aiAssets.cleanupRecords())); }}><summary>异常清理记录</summary>
      {!audits.length ? <p>暂无清理记录</p> : audits.map(item => <p key={item.id}>{new Date(item.createdAt).toLocaleString()} · {item.reason} · 消息 {item.messages} / 对话 {item.conversations}<br />来源 {item.sourceId} · {item.adapter}{item.apiOrigin ? ` · ${item.apiOrigin}` : ''}</p>)}
    </details>
  </div>;
}
