/* =====================================================================
   pages/BrowserView/BookmarksBar/BookmarkManager.tsx —— 书签管理器（v0.0.9）
   新标签页承载，全量管理书签：搜索 / 表格展示 / 编辑 / 删除 / 切换书签栏。
   ===================================================================== */

import { useEffect, useMemo, useState } from 'react';
import { useBookmarkStore } from '../../../store/useBookmarkStore';
import { useBrowserTabStore } from '../../../store/useBrowserTabStore';
import { IconButton } from '../../../components/ui';
import { BookmarkEditDialog } from './BookmarkContextMenu';

interface BookmarkManagerProps {
  onOpenInNewTab: (url: string) => void;
}

export default function BookmarkManager({ onOpenInNewTab }: BookmarkManagerProps) {
  // 书签主打开：已存在同 URL 标签则切换聚焦（标准书签语义）；「在新标签打开」图标保持新建
  const openTabOrFocus = useBrowserTabStore((s) => s.openTabOrFocus);
  const bookmarks = useBookmarkStore((s) => s.bookmarks);
  const load = useBookmarkStore((s) => s.load);
  const remove = useBookmarkStore((s) => s.remove);
  const update = useBookmarkStore((s) => s.update);
  const toggleBar = useBookmarkStore((s) => s.toggleBar);

  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!query.trim()) return bookmarks;
    const q = query.toLowerCase();
    return bookmarks.filter(
      (b) =>
        b.title.toLowerCase().includes(q) ||
        b.url.toLowerCase().includes(q) ||
        b.profileName.toLowerCase().includes(q),
    );
  }, [bookmarks, query]);

  const editingBookmark = bookmarks.find((b) => b.id === editing);

  return (
    <div className="browser-bookmark-manager" data-name="browser.bookmark-manager">
      <div className="browser-bookmark-manager-title" data-name="browser.bookmark-manager-title">书签管理器</div>
      <div className="browser-bookmark-manager-toolbar" data-name="browser.bookmark-manager-toolbar">
        <input
          className="browser-bookmark-manager-search" data-name="browser.bookmark-manager-search"
          type="text"
          placeholder="搜索书签（名称/网址/来源）..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <div style={{ padding: 'var(--space-6)', textAlign: 'center', color: 'var(--muted-foreground)', fontSize: 'var(--text-xs)' }}>
          {query ? '无匹配书签' : '暂无书签，点击地址栏星标收藏网页'}
        </div>
      ) : (
        <div
          style={{ background: 'var(--card)', border: '1px solid var(--glass-bd-2)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}
          data-name="browser.bookmark-manager-table-card"
        >
        <table className="browser-bookmark-manager-table" data-name="browser.bookmark-manager-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>网址</th>
              <th>来源</th>
              <th>书签栏</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((b) => (
              <tr key={b.id}>
                <td>{b.title}</td>
                <td style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      openTabOrFocus(b.url, { kind: 'web' });
                    }}
                    style={{ color: 'var(--accent-bright)', textDecoration: 'none' }}
                  >
                    {b.url}
                  </a>
                </td>
                <td style={{ fontSize: 'var(--text-xs)', color: 'var(--muted-foreground)' }}>
                  {b.profileName}{b.platformName ? ` / ${b.platformName}` : ''}
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={b.inBookmarkBar}
                    onChange={() => void toggleBar(b.id, !b.inBookmarkBar)}
                  />
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 'var(--space-0-5)' }} data-name="browser.bookmark-manager-actions">
                    <IconButton aria-label="在新标签打开" title="在新标签打开" onClick={() => onOpenInNewTab(b.url)}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                        <polyline points="15 3 21 3 21 9" />
                      </svg>
                    </IconButton>
                    <IconButton aria-label="修改" title="修改" onClick={() => setEditing(b.id)}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                      </svg>
                    </IconButton>
                    <IconButton aria-label="删除" title="删除" onClick={() => void remove(b.id)}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </IconButton>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {editingBookmark && (
        <BookmarkEditDialog
          bookmark={editingBookmark}
          onSave={(title, url) => {
            void update(editingBookmark.id, { title, url });
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}
