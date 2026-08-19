/* =====================================================================
   pages/NotesView.tsx —— 灵感笔记（v2：TipTap 富文本 + 搜索 + 分类 + flushDraft）
   架构：
   - 容器组件 NotesView：组合 useNotesData + NotesSidebar + NotesEditor
   - 展示子组件 NotesSidebar：搜索框 + 标签筛选 + 笔记列表（置顶/普通）
   - 展示子组件 NotesEditor：TipTap 编辑器 + 标题 + 标签 + 置顶 + 工具栏
   - 数据层 useNotesData：状态 + 数据加载 + 搜索/筛选 + flushDraft
   - 编辑器逻辑 useNotesEditor：markdown 编辑 + 快捷键 + 内容变化
   数据丢失修复（核心）：
   - 切换笔记 / 组件卸载 / beforeunload 前 flushDraft
   - flushDraft 将 draftRef 中的草稿同步保存到 SQLite
   ===================================================================== */

import { useNotesData } from './hooks/useNotesData.js';
import NotesSidebar from './components/NotesSidebar.js';
import NotesEditor from './components/NotesEditor.js';
import SaveAsPromptModal from '../components/SaveAsPromptModal.js';
import './NotesView.css';

interface NotesViewProps {
  onClose?: () => void;
  onOpenSettings?: () => void;
}

export default function NotesView({ onOpenSettings }: NotesViewProps) {
  const {
    notes,
    activeNote,
    searchKeyword,
    setSearchKeyword,
    filterTag,
    setFilterTag,
    allTags,
    sidebarWidth,
    sidebarCollapsed,
    handleSidebarResize,
    handleSidebarToggleCollapse,
    toast,
    showToast,
    saveAsPromptOpen,
    saveAsPromptContent,
    saveAsPromptTitle,
    setSaveAsPromptOpen,
    handleNew,
    handleSelectNote,
    handleDelete,
    handleContentChange,
    handleTogglePin,
    handleTagsChange,
    handleSendToAi,
    handleSaveAsPrompt,
  } = useNotesData();

  return (
    <div className="notes-view app-view-root" data-name="advanced-panel.notes-view">
      <div className="notes-body" data-name="advanced-panel.notes-body">
        <NotesSidebar
          notes={notes}
          activeId={activeNote?.id || null}
          allTags={allTags}
          searchKeyword={searchKeyword}
          filterTag={filterTag}
          onSearchChange={setSearchKeyword}
          onTagFilter={setFilterTag}
          onSelect={handleSelectNote}
          onCreate={handleNew}
          onDelete={handleDelete}
          width={sidebarWidth}
          collapsed={sidebarCollapsed}
          onResize={handleSidebarResize}
          onToggleCollapse={handleSidebarToggleCollapse}
          onOpenSettings={onOpenSettings}
        />
        <NotesEditor
          note={activeNote}
          onContentChange={handleContentChange}
          onTogglePin={handleTogglePin}
          onTagsChange={handleTagsChange}
          onSendToAi={handleSendToAi}
          onSaveAsPrompt={handleSaveAsPrompt}
        />
      </div>
      {toast && <div className="notes-toast app-toast" data-name="advanced-panel.notes-toast">{toast}</div>}
      <SaveAsPromptModal
        open={saveAsPromptOpen}
        initialContent={saveAsPromptContent}
        initialTitle={saveAsPromptTitle}
        onSaved={() => {
          setSaveAsPromptOpen(false);
          showToast('已保存为提示词');
        }}
        onClose={() => setSaveAsPromptOpen(false)}
      />
    </div>
  );
}
