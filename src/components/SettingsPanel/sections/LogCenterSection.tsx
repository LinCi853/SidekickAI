import { useEffect, useMemo, useState } from 'react';
import { Button, EmptyState } from '../../ui';
import ConfirmDialog from '../../ui/ConfirmDialog';
import { listLoginTraces, listWindowTraces, clearLoginTraces, clearWindowTraces, listProfiles } from '../../../lib/electron-api';
import type { LoginTrace, WindowTrace, Profile } from '../../../lib/electron-api';
import './LogCenterSection.css';

const actions: Record<string, string> = { create: '打开', close: '关闭', maximize: '最大化', unmaximize: '退出最大化', minimize: '最小化',
  restore: '恢复', tab_switch: '切换标签', pin_toggle: '切换置顶', show: '显示', hide: '隐藏' };
const windowName = (id: string) => ({ main: '主窗口', settings: '设置', prompts: 'AI资产', history: 'AI资产', 'advanced-panel': '进阶面板' }[id] ?? id);
export default function LogCenterSection({ collapsible = false }: { collapsible?: boolean } = {}) {
  const [expanded, setExpanded] = useState(!collapsible);
  const [category, setCategory] = useState<'logins' | 'windows'>('logins');
  const [filter, setFilter] = useState('');
  const [query, setQuery] = useState('');
  const [logins, setLogins] = useState<LoginTrace[]>([]);
  const [windows, setWindows] = useState<WindowTrace[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [error, setError] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!expanded) return;
    let active = true;
    void Promise.all([listLoginTraces(), listWindowTraces(undefined, 500), listProfiles()]).then(([login, window, profile]) => {
      if (active) { setLogins(login); setWindows(window); setProfiles(profile); setError(''); }
    }).catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [expanded, revision]);
  const name = (id: string) => profiles.find(profile => profile.id === id)?.name ?? id;
  const sources = useMemo(() => [...new Set(category === 'logins' ? logins.map(item => item.profileId) : windows.map(item => item.windowId))], [category, logins, windows]);
  const visibleLogins = logins.filter(item => (!filter || item.profileId === filter)
    && (!query || `${name(item.profileId)} ${item.platform ?? ''} ${item.loginUrl ?? ''}`.toLowerCase().includes(query.toLowerCase())));
  const visibleWindows = windows.filter(item => (!filter || item.windowId === filter)
    && (!query || `${windowName(item.windowId)} ${actions[item.action] ?? item.action}`.includes(query)));
  const clear = async () => {
    try {
      if (category === 'logins') await clearLoginTraces(filter || undefined);
      else await clearWindowTraces(filter || undefined);
      setConfirmClear(false); setRevision(value => value + 1);
    } catch (failure) { setError(String(failure)); }
  };
  const body = <><div className="log-center-tools">
    <select aria-label="日志类别" value={category} onChange={event => { setCategory(event.target.value as typeof category); setFilter(''); }}>
      <option value="logins">登录记录</option><option value="windows">窗口记录</option></select>
    <select aria-label="日志来源" value={filter} onChange={event => setFilter(event.target.value)}><option value="">全部来源</option>
      {sources.map(id => <option key={id} value={id}>{category === 'logins' ? name(id) : windowName(id)}</option>)}</select>
    <input aria-label="筛选日志" placeholder="筛选名称或操作" value={query} onChange={event => setQuery(event.target.value)} />
    <Button variant="outline" onClick={() => setRevision(value => value + 1)}>刷新</Button>
    <Button variant="danger" onClick={() => setConfirmClear(true)}>清空记录</Button>
  </div>{error && <p role="alert">{error}</p>}
  <div className="log-center-list">{category === 'logins' ? visibleLogins.length ? visibleLogins.map(item => <article key={item.id}>
    <strong>{name(item.profileId)}</strong><span>{item.platform || 'AI 应用'} · {new Date(item.loginTime).toLocaleString()}</span>
    <p>{item.loginUrl || '登录地址未记录'}</p></article>) : <EmptyState message="暂无匹配的登录记录" />
    : visibleWindows.length ? visibleWindows.map(item => <article key={item.id}><strong>{windowName(item.windowId)}</strong>
      <span>{actions[item.action] ?? item.action} · {new Date(item.timestamp).toLocaleString()}</span></article>) : <EmptyState message="暂无匹配的窗口记录" />}</div>
  {category === 'windows' && <p className="section-hint">显示最近 500 条窗口操作。</p>}
  <ConfirmDialog open={confirmClear} title="清空日志" message={`清空${filter ? '当前来源的' : '全部'}${category === 'logins' ? '登录' : '窗口'}记录。当前文字筛选不限制清空范围；账号登录状态和窗口设置保持原状。`}
    variant="danger" onCancel={() => setConfirmClear(false)} onConfirm={clear} />
  </>;
  return collapsible ? <details className="log-center" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>日志中心</summary>{expanded && body}</details> : <section className="log-center" data-name="settings.log-center"><h3>日志中心</h3>{body}</section>;
}
