import { useEffect, useState } from 'react';
import { Button } from '../../components/ui';
import { requireElectron } from '../../lib/electron-api/core';
import type { AssetCollectionIssue } from '../../../electron/shared/ai-assets.types';

export default function AssetCollectionStatus({ onAction }: {
  onAction: (operation: () => Promise<void>) => void;
}) {
  const api = requireElectron().aiAssets;
  const [issues, setIssues] = useState<AssetCollectionIssue[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let changed = false;
    const off = api.onCollectionIssuesChanged(next => {
      changed = true;
      if (active) { setIssues(next); setError(''); }
    });
    void api.collectionIssues().then(next => {
      if (active && !changed) setIssues(next);
    }).catch(() => {
      if (active && !changed) setError('暂时无法读取收纳状态，请重新打开 AI资产');
    });
    return () => { active = false; off(); };
  }, [api]);
  if (error) return <p className="asset-feedback asset-error" role="alert">{error}</p>;
  if (!issues.length) return null;
  return <div className="asset-feedback" role="status" aria-label="等待补收的对话">
    {issues.map(issue => <div key={issue.profileId} className="asset-actions">
      <span>{issue.profileName}：{issue.paused
        ? '采集已暂停，新页面变化暂不记录，已捕获内容等待恢复。请保留原页面。'
        : issue.pendingObservations
          ? `已捕获的 ${issue.pendingObservations} 份记录正在等待收纳，恢复后会继续写入。`
          : '部分已捕获内容仍在等待收纳或关联，正在重试。请保留原页面。'}
        {!issue.webContentsId && ' 请重新打开此账号页面。'}</span>
      <Button variant="outline" disabled={!issue.webContentsId} onClick={() => onAction(async () => {
        if (!await api.focusPage(issue.webContentsId, issue.profileId)) throw new Error('此账号页面已关闭，请重新打开');
      })}>打开此账号页面</Button>
    </div>)}
  </div>;
}
