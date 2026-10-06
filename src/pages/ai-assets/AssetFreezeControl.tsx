import { useEffect, useState } from 'react';
import { Button } from '../../components/ui';
import { requireElectron } from '../../lib/electron-api/core';
import type { AiAssetsAPI } from '../../../electron/shared/ai-assets.types';

export default function AssetFreezeControl({ target, onAction }: { target?: { tabId: string; revision: number }; onAction: (operation: () => Promise<void>) => void }) {
  const api = requireElectron();
  const [pages, setPages] = useState<Awaited<ReturnType<AiAssetsAPI['freezeTargets']>>>([]);
  const [selected, setSelected] = useState('');
  const [frozen, setFrozen] = useState(false);
  const [error, setError] = useState('');
  const refresh = async () => {
    const targets = await api.aiAssets.freezeTargets();
    setPages(targets); setSelected(value => targets.some(item => item.tabId === target?.tabId) ? target!.tabId : targets.some(item => item.tabId === value) ? value : targets[0]?.tabId ?? '');
  };
  useEffect(() => { void refresh().catch(failure => setError(String(failure))); }, [target]);
  useEffect(() => {
    let active = true;
    if (selected) void api.freeze.status(selected).then(value => { if (active) setFrozen(value.state === 'frozen'); }).catch(() => {});
    else setFrozen(false);
    const off = api.freeze.onStateChanged(value => { if (value.tabId === selected) setFrozen(value.state === 'frozen'); });
    return () => { active = false; off(); };
  }, [selected]);
  return <div className="asset-freeze-control"><label>手动页面冻结 <select aria-label="冻结页面" value={selected} onChange={event => setSelected(event.target.value)}>
    {!pages.length && <option value="">请先打开 AI 页面</option>}
    {pages.map(item => <option key={item.tabId} value={item.tabId}>{item.title}</option>)}
  </select></label><Button variant="outline" onClick={() => onAction(refresh)}>刷新页面</Button>
    <Button variant="outline" disabled={!selected} onClick={() => onAction(async () => {
      const page = pages.find(item => item.tabId === selected);
      if (!page) return;
      if (frozen) { await api.freeze.resume(page.tabId); setFrozen(false); return; }
      if (!await api.freeze.registerWebview(page)) throw new Error('页面已关闭，请刷新页面列表');
      if (!await api.aiAssets.focusPage(page.webContentsId, page.profileId)) throw new Error('页面窗口不可用，请刷新页面列表');
      const result = await api.freeze.freezeTab({ tabId: page.tabId, profileId: page.profileId });
      if (!frozen && !result.frozen) throw new Error('页面冻结未成功，请重试');
      setFrozen(result.frozen);
    })}>{frozen ? '恢复页面' : '冻结页面'}</Button>
    <span>冻结时转到目标页面；切换窗口或退出时自动恢复。</span>{error && <span role="alert">{error}</span>}
  </div>;
}
