/* =====================================================================
   pages/components/NotesSidebar.tsx —— 灵感笔记侧边栏展示组件
   搜索框 + 标签筛选 + 笔记列表（置顶/普通）
   ===================================================================== */

import type { Note } from '../../../electron/shared/types.js';
import { EmptyState } from '../../components/ui';
import IconButton from '../../components/ui/IconButton.js';
import SidebarShell from '../../components/SidebarShell.js';

interface NotesSidebarProps {
  notes: Note[];
  activeId: string | null;
  allTags: string[];
  searchKeyword: string;
  filterTag: string | undefined;
  onSearchChange: (keyword: string) => void;
  onTagFilter: (tag: string | undefined) => void;
  onSelect: (note: Note) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  width: number;
  collapsed: boolean;
  onResize: (w: number) => void;
  onToggleCollapse: () => void;
  onOpenSettings?: () => void;
}

export default function NotesSidebar({
  notes,
  activeId,
  allTags,
  searchKeyword,
  filterTag,
  onSearchChange,
  onTagFilter,
  onSelect,
  onCreate,
  onDelete,
  width,
  collapsed,
  onResize,
  onToggleCollapse,
  onOpenSettings,
}: NotesSidebarProps) {
  const pinnedNotes = notes.filter((n) => n.pinned);
  const normalNotes = notes.filter((n) => !n.pinned);

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  const renderNoteItem = (note: Note, idx: number) => (
    <div
      key={note.id}
      className={`notes-sidebar-item ${note.id === activeId ? 'active' : ''}`}
      onClick={() => onSelect(note)}
      data-name={`advanced-panel.notes-sidebar-item-${idx + 1}`}
      data-index={idx + 1}
      data-id={note.id}
      data-pinned={note.pinned ? 'true' : 'false'}
    >
      <div className="notes-sidebar-item-main" data-name={`advanced-panel.notes-sidebar-item-${idx + 1}-main`}>
        <div className="notes-sidebar-item-title" data-name={`advanced-panel.notes-sidebar-item-${idx + 1}-title`}>
          {note.pinned && <span className="notes-pin-icon">★</span>}
          {note.title || note.content.split('\n').find((l) => l.trim())?.slice(0, 30) || '空白笔记'}
        </div>
        <div className="notes-sidebar-item-meta" data-name={`advanced-panel.notes-sidebar-item-${idx + 1}-meta`}>
          <span className="notes-sidebar-item-time" data-name={`advanced-panel.notes-sidebar-item-${idx + 1}-time`}>{formatTime(note.updatedAt)}</span>
          {note.tags.length > 0 && (
            <span className="notes-sidebar-item-tags" data-name={`advanced-panel.notes-sidebar-item-${idx + 1}-tags`}>
              {note.tags.map((t) => (
                <span key={t} className="notes-tag-chip" data-name={`advanced-panel.notes-sidebar-item-${idx + 1}-tag-${t}`}>{t}</span>
              ))}
            </span>
          )}
        </div>
      </div>
      <button
        className="notes-sidebar-item-delete sidebar-list-item-delete"
        onClick={(e) => { e.stopPropagation(); onDelete(note.id); }}
        title="删除"
        aria-label="删除笔记"
        data-name={`advanced-panel.notes-sidebar-item-${idx + 1}-delete-button`}
      >
        ×
      </button>
    </div>
  );

  const collapsedItems = notes.map((n) => ({
    id: n.id,
    label: n.title || n.content.split('\n').find((l) => l.trim())?.slice(0, 20) || '空白笔记',
    active: n.id === activeId,
    onClick: () => onSelect(n),
  }));

  return (
    <SidebarShell
      collapsed={collapsed}
      width={width}
      onResize={onResize}
      onToggleCollapse={onToggleCollapse}
      onOpenSettings={onOpenSettings}
      onNew={onCreate}
      newTitle="新建笔记"
      collapsedItems={collapsedItems}
      dataName="advanced-panel.notes-sidebar"
      header={
        <div className="sidebar-shell-header" data-name="advanced-panel.notes-sidebar-search">
          <input
            type="text"
            className="notes-search-input"
            placeholder="搜索笔记…"
            value={searchKeyword}
            onChange={(e) => onSearchChange(e.target.value)}
            data-name="advanced-panel.notes-sidebar-search-input"
          />
          <IconButton
            type="button"
            className="sidebar-shell-new-btn"
            onClick={onCreate}
            title="新建笔记"
            aria-label="新建笔记"
            data-name="advanced-panel.notes-sidebar-create-button"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </IconButton>
        </div>
      }
    >
      {allTags.length > 0 && (
        <div className="notes-sidebar-tags" data-name="advanced-panel.notes-sidebar-tags">
          <button
            className={`notes-tag-filter ${!filterTag ? 'active' : ''}`}
            onClick={() => onTagFilter(undefined)}
            data-name="advanced-panel.notes-sidebar-tag-filter-all"
          >
            全部
          </button>
          {allTags.map((tag, idx) => (
            <button
              key={tag}
              className={`notes-tag-filter ${filterTag === tag ? 'active' : ''}`}
              onClick={() => onTagFilter(filterTag === tag ? undefined : tag)}
              data-name={`advanced-panel.notes-sidebar-tag-filter-${idx + 1}`}
              data-tag={tag}
            >
              {tag}
            </button>
          ))}
        </div>
      )}
      <div className="sidebar-shell-list" data-name="advanced-panel.notes-sidebar-list">
        {notes.length === 0 && (
          <EmptyState
            message={searchKeyword || filterTag ? '无匹配笔记' : '点击 + 新建笔记'}
            className="notes-sidebar-empty"
            data-name="advanced-panel.notes-sidebar-empty"
          />
        )}
        {pinnedNotes.length > 0 && (
          <>
            <div className="notes-sidebar-section" data-name="advanced-panel.notes-sidebar-section-pinned">置顶</div>
            {pinnedNotes.map((n, i) => renderNoteItem(n, i))}
          </>
        )}
        {normalNotes.length > 0 && (
          <>
            {pinnedNotes.length > 0 && <div className="notes-sidebar-section" data-name="advanced-panel.notes-sidebar-section-all">全部</div>}
            {normalNotes.map((n, i) => renderNoteItem(n, pinnedNotes.length + i))}
          </>
        )}
      </div>
    </SidebarShell>
  );
}
