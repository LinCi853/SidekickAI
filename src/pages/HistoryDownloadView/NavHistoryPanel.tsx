/* =====================================================================
   pages/HistoryDownloadView/NavHistoryPanel.tsx —— 导航历史面板
   顶部：实时搜索框 + 「清空所有」按钮
   列表：按时间分组（今天 / 昨天 / 本周 / 更早），每条显示 标题 + URL + 时间 + 删除
   点击条目：openExternal 打开
   API：navHistory.list / navHistory.search / navHistory.delete / navHistory.clearAll
   ===================================================================== */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, IconButton } from '@/components/ui';
import { SearchIcon, TrashIcon } from '@/components/icons';
import {
  listNavHistory,
  searchNavHistory,
  deleteNavHistory,
  clearAllNavHistory,
  openExternal,
} from '@/lib/electron-api';
import type { NavHistoryEntry } from '@/lib/electron-api';
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback';
import { formatTime } from '@/lib/datetime';

/** 时间分组键 */
type GroupKey = 'today' | 'yesterday' | 'thisWeek' | 'earlier';

const GROUP_LABEL: Record<GroupKey, string> = {
  today: '今天',
  yesterday: '昨天',
  thisWeek: '本周',
  earlier: '更早',
};

/** 计算时间分组：以本地日期边界为准，本周 = 今天往前到本周一 */
function resolveGroup(ts: number, now: Date): GroupKey {
  const d = new Date(ts);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  if (ts >= startOfToday) return 'today';
  if (ts >= startOfToday - dayMs) return 'yesterday';
  // 周一 00:00 为本周起点（getDay() 周日=0 → 转换为 6）
  const dayOfWeek = (now.getDay() + 6) % 7;
  const startOfWeek = startOfToday - dayOfWeek * dayMs;
  if (ts >= startOfWeek) return 'thisWeek';
  return 'earlier';
}

interface NavHistoryPanelProps {
  /** 总数变化时通知父组件刷新侧栏计数 */
  onCountChange?: (count: number) => void;
}

export default function NavHistoryPanel({ onCountChange }: NavHistoryPanelProps) {
  const [entries, setEntries] = useState<NavHistoryEntry[]>([]);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (kw: string) => {
    setLoading(true);
    setError(null);
    try {
      const list = kw.trim()
        ? await searchNavHistory(undefined, kw.trim())
        : await listNavHistory(undefined, 1, 200);
      setEntries(list);
      onCountChange?.(list.length);
    } catch (e) {
      console.error('[NavHistoryPanel] 加载失败:', e);
      setError('加载失败');
      setEntries([]);
      onCountChange?.(0);
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);

  // 初始化加载
  useEffect(() => {
    void refresh('');
  }, [refresh]);

  // 实时搜索（防抖 300ms）
  const debouncedRefresh = useDebouncedCallback((kw: string) => {
    void refresh(kw);
  }, 300);

  useEffect(() => {
    debouncedRefresh(keyword);
  }, [keyword, debouncedRefresh]);

  const handleOpen = useCallback(async (url: string) => {
    try {
      await openExternal(url);
    } catch (e) {
      console.error('[NavHistoryPanel] openExternal 失败:', e);
    }
  }, []);

  const handleDelete = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await deleteNavHistory(id);
      setEntries((prev) => {
        const next = prev.filter((x) => x.id !== id);
        onCountChange?.(next.length);
        return next;
      });
    } catch (err) {
      console.error('[NavHistoryPanel] 删除失败:', err);
      alert('删除失败');
    }
  }, [onCountChange]);

  const handleClearAll = useCallback(async () => {
    if (!confirm('确定要清空全部导航历史吗？此操作不可恢复！')) return;
    try {
      await clearAllNavHistory();
      setEntries([]);
      onCountChange?.(0);
    } catch (err) {
      console.error('[NavHistoryPanel] 清空失败:', err);
      alert('清空失败');
    }
  }, [onCountChange]);

  // 按时间分组
  const grouped = useMemo(() => {
    const now = new Date();
    const map = new Map<GroupKey, NavHistoryEntry[]>();
    for (const entry of entries) {
      const key = resolveGroup(entry.timestamp, now);
      const arr = map.get(key) ?? [];
      arr.push(entry);
      map.set(key, arr);
    }
    const order: GroupKey[] = ['today', 'yesterday', 'thisWeek', 'earlier'];
    return order
      .filter((k) => map.has(k))
      .map((k) => ({ key: k, items: map.get(k)! }));
  }, [entries]);

  return (
    <div className="hd-content" data-name="hd.nav.container">
      <div className="hd-toolbar" data-name="hd.nav.toolbar">
        <div className="hd-toolbar-search" data-name="hd.nav.search-wrap">
          <SearchIcon className="hd-toolbar-search-icon" />
          <input
            type="text"
            className="hd-toolbar-search-input"
            data-name="hd.nav.search-input"
            placeholder="搜索导航历史（标题或 URL）…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            autoFocus
          />
        </div>
        <span className="hd-toolbar-count" data-name="hd.nav.count">
          共 {entries.length} 条
        </span>
        <div className="hd-toolbar-spacer" />
        <Button
          variant="danger"
          type="button"
          data-name="hd.nav.clear-all-button"
          disabled={entries.length === 0}
          onClick={() => void handleClearAll()}
        >
          清空所有
        </Button>
      </div>

      <div className="hd-list" data-name="hd.nav.list">
        {loading && entries.length === 0 && (
          <div className="hd-empty" data-name="hd.nav.loading">加载中…</div>
        )}
        {!loading && entries.length === 0 && (
          <div className="hd-empty" data-name="hd.nav.empty">
            {keyword.trim() ? '未找到匹配的导航记录' : '暂无导航历史'}
          </div>
        )}
        {error && (
          <div className="hd-empty" data-name="hd.nav.error">{error}</div>
        )}
        {grouped.map((group) => (
          <div key={group.key} className="hd-group" data-name={`hd.nav.group-${group.key}`}>
            <div className="hd-group-header" data-name={`hd.nav.group-header-${group.key}`}>
              {GROUP_LABEL[group.key]} · {group.items.length}
            </div>
            {group.items.map((entry, idx) => (
              <div
                key={entry.id}
                className="hd-item"
                data-name={`hd.nav.item-${idx + 1}`}
                data-index={idx + 1}
                data-id={entry.id}
                title={entry.url}
                onClick={() => void handleOpen(entry.url)}
              >
                <div className="hd-item-head">
                  <span className="hd-item-title" data-name={`hd.nav.item-title-${idx + 1}`}>
                    {entry.title || entry.url}
                  </span>
                  <span className="hd-item-time" data-name={`hd.nav.item-time-${idx + 1}`}>
                    {formatTime(entry.timestamp, 'datetime')}
                  </span>
                  <div className="hd-item-actions">
                    <IconButton
                      type="button"
                      variant="close"
                      aria-label="删除"
                      title="删除"
                      data-name={`hd.nav.item-delete-${idx + 1}`}
                      onClick={(e) => void handleDelete(entry.id, e)}
                    >
                      <TrashIcon />
                    </IconButton>
                  </div>
                </div>
                <div className="hd-item-url" data-name={`hd.nav.item-url-${idx + 1}`}>
                  {entry.url}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
