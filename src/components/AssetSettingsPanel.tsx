import { useEffect, useState } from 'react';
import { Button, ConfirmDialog } from './ui';
import { requireElectron } from '../lib/electron-api/core';
import { useAssetSettings } from '../hooks/useAssetSettings';
import { ASSET_SHORTCUT_LABELS } from '../../electron/shared/asset-settings';
import type { AssetCleanupRecord, AssetRetentionStatus, AssetSettings } from '../../electron/shared/ai-assets.types';
import type { HotkeyConfig } from '../../electron/shared/types';
import './AssetSettingsPanel.css';

export default function AssetSettingsPanel(_props: Record<string, never> = {}) {
  const api = requireElectron();
  const { settings, update, error: settingsError } = useAssetSettings();
  const [hotkey, setHotkey] = useState<HotkeyConfig>();
  const [globalDraft, setGlobalDraft] = useState('');
  const [drafts, setDrafts] = useState(settings.localShortcuts);
  const [error, setError] = useState('');
  const [audits, setAudits] = useState<AssetCleanupRecord[]>([]);
  const [retention, setRetention] = useState<AssetRetentionStatus>();
  const [pendingDays, setPendingDays] = useState<AssetSettings['fileRetentionDays']>();
  useEffect(() => { setDrafts(settings.localShortcuts); }, [settings.localShortcuts]);
  useEffect(() => {
    let active = true, received = false;
    const off = api.aiAssets.onRetentionStatusChanged(value => { received = true; if (active) setRetention(value); });
    void api.aiAssets.retentionStatus().then(value => { if (active && !received) setRetention(value); }).catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; off(); };
  }, [api]);
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
    <label>资料自动删除 <select aria-label="资料自动删除" value={settings.fileRetentionDays} onChange={event => {
      const days = Number(event.target.value) as AssetSettings['fileRetentionDays'];
      if (days && (!settings.fileRetentionDays || days < settings.fileRetentionDays)) setPendingDays(days);
      else void update({ fileRetentionDays: days });
    }}><option value={0}>关闭</option><option value={14}>14 天</option><option value={30}>30 天</option><option value={120}>120 天</option></select></label>
    {settings.fileRetentionDays > 0 && <p className="asset-retention-status" role="status">
      {retention?.state === 'error' ? `自动删除未完成：${retention.error}` : retention?.state === 'waiting' ? '等待响应、传输、导入、备份或文件读取结束'
        : retention?.cleanupPending ? '文件记录已清理，部分原件等待释放后重试' : retention?.lastRun ? `最近检查：${new Date(retention.lastRun).toLocaleString()} · 本次运行已删除 ${retention.deleted} 份资料` : '等待自动检查'}
    </p>}
    <ConfirmDialog open={pendingDays !== undefined} title="启用资料自动删除" variant="danger" confirmLabel="确认自动删除" message={`将删除最近收纳或更新已满 ${pendingDays ?? 0} 天的资料记录及无引用原件，现有超期资料也会删除。对话、提示词及历史冻结快照保留。删除不可撤销，请先导出需要长期保留的资料。`}
      onCancel={() => setPendingDays(undefined)} onConfirm={async () => { if (pendingDays !== undefined) await update({ fileRetentionDays: pendingDays }); setPendingDays(undefined); }} />
    <fieldset><legend>全局快捷键</legend><label>打开／关闭 AI资产 <input aria-label="打开／关闭 AI资产快捷键" placeholder="未绑定" value={globalDraft} onChange={event => setGlobalDraft(event.target.value)} /></label>
      <Button variant="outline" onClick={() => void run(async () => { if (!await api.hotkey.set('toggleAiAssets', globalDraft.trim())) throw new Error('快捷键未注册，请选择其他组合'); })}>保存全局快捷键</Button>
      <label><input type="checkbox" checked={hotkey?.enabled ?? false} disabled={!hotkey?.accelerator} onChange={event => void run(() => api.hotkey.setEnabled('toggleAiAssets', event.target.checked))} />启用全局快捷键</label>
      {hotkey?.registrationReason && <p role="status">{hotkey.registrationReason}</p>}
    </fieldset>
    <fieldset><legend>AI资产窗口内快捷键</legend>
      {(Object.keys(ASSET_SHORTCUT_LABELS) as Array<keyof typeof drafts>).map(key => <label key={key}>{ASSET_SHORTCUT_LABELS[key]}<input aria-label={`${ASSET_SHORTCUT_LABELS[key]}快捷键`} value={drafts[key]} onChange={event => setDrafts({ ...drafts, [key]: event.target.value })} /></label>)}
      <Button variant="outline" onClick={() => void update({ localShortcuts: drafts })}>保存局部快捷键</Button>
    </fieldset>
    <details onToggle={event => { if (event.currentTarget.open) void run(async () => setAudits(await api.aiAssets.cleanupRecords())); }}><summary>异常清理记录</summary>
      {!audits.length ? <p>暂无清理记录</p> : audits.map(item => <p key={item.id}>{new Date(item.createdAt).toLocaleString()} · {item.reason === 'ambiguous-message-identity' ? '消息标识不明确，已跳过并保留原记录' : item.reason} · 消息 {item.messages} / 对话 {item.conversations}<br />来源 {item.sourceId} · {item.adapter}{item.apiOrigin ? ` · ${item.apiOrigin}` : ''}</p>)}
    </details>
  </div>;
}
