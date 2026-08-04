/* =====================================================================
   pages/BrowserView/BookmarksBar/BookmarkContextMenu.tsx —— 书签右键菜单（v0.0.9）
   9 项：在新标签打开 / 修改(窗口遮罩) / 剪切 / 复制 / 粘贴 / 删除 /
        是否显示到书签栏 / 是否展示书签栏 / 书签管理器
   ===================================================================== */

import { useEffect, useState } from 'react';

import { createPortal } from 'react-dom';
import Popover, { PopoverItem, PopoverDivider } from '../../../components/ui/Popover';
import type { Bookmark } from '../../../lib/electron-api';

interface BookmarkContextMenuProps {
  position: { x: number; y: number };
  bookmark: Bookmark;
  bookmarkBarVisible: boolean;
  onClose: () => void;
  onOpenInNewTab: () => void;
  onOpenInNewWindow?: () => void;
  onEdit: () => void;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onDelete: () => void;
  onToggleBarVisibility: () => void;
  onToggleBookmarkBar: () => void;
  onOpenManager: () => void;
  /** 剪贴板是否有内容可粘贴 */
  hasClipboard: boolean;
}

export default function BookmarkContextMenu({
  position,
  bookmark,
  bookmarkBarVisible,
  onClose,
  onOpenInNewTab,
  onOpenInNewWindow,
  onEdit,
  onCut,
  onCopy,
  onPaste,
  onDelete,
  onToggleBarVisibility,
  onToggleBookmarkBar,
  onOpenManager,
  hasClipboard,
}: BookmarkContextMenuProps) {

  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <Popover
      isOpen={true}
      onClose={onClose}
      position={position}
      variant="context-menu"
      config={{ closeOnOutsideClick: true, closeOnEsc: true }}
      dataName="browser.bookmark-context-menu"
    >
      <PopoverItem onClick={run(onOpenInNewTab)} label="在新标签页中打开" dataName="browser.bookmark-ctx-open" />
      {onOpenInNewWindow && (
        <PopoverItem onClick={run(onOpenInNewWindow)} label="在新窗口中打开" dataName="browser.bookmark-ctx-open-window" />
      )}
      <PopoverItem onClick={run(onEdit)} label="修改" dataName="browser.bookmark-ctx-edit" />
      <PopoverDivider />
      <PopoverItem onClick={run(onCut)} label="剪切" dataName="browser.bookmark-ctx-cut" />
      <PopoverItem onClick={run(onCopy)} label="复制" dataName="browser.bookmark-ctx-copy" />
      <PopoverItem onClick={run(onPaste)} label="粘贴" disabled={!hasClipboard} dataName="browser.bookmark-ctx-paste" />
      <PopoverDivider />
      <PopoverItem onClick={run(onDelete)} label="删除" danger dataName="browser.bookmark-ctx-delete" />
      <PopoverDivider />
      <PopoverItem
        onClick={run(onToggleBarVisibility)}
        label={bookmark.inBookmarkBar ? '从书签栏移除' : '显示到书签栏'}
        active={bookmark.inBookmarkBar}
        dataName="browser.bookmark-ctx-toggle-bar"
      />
      <PopoverItem
        onClick={run(onToggleBookmarkBar)}
        label={bookmarkBarVisible ? '隐藏书签栏' : '显示书签栏'}
        active={bookmarkBarVisible}
        dataName="browser.bookmark-ctx-toggle-bar-visibility"
      />
      <PopoverDivider />
      <PopoverItem onClick={run(onOpenManager)} label="书签管理器" dataName="browser.bookmark-ctx-manager" />
    </Popover>
  );
}

/** 书签编辑弹窗（窗口遮罩，使用 Portal 渲染到 body 确保覆盖整个 browser.container） */
export function BookmarkEditDialog({
  bookmark,
  onSave,
  onCancel,
}: {
  bookmark: Bookmark;
  onSave: (title: string, url: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(bookmark.title);
  const [url, setUrl] = useState(bookmark.url);

  // ESC 关闭
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  return createPortal(
    <div className="browser-bookmark-edit-overlay" data-name="browser.bookmark-edit-overlay" onClick={onCancel}>
      <div className="browser-bookmark-edit-dialog" data-name="browser.bookmark-edit-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>修改书签</h3>
        <label>名称</label>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus data-name="browser.bookmark-edit-title-input" />
        <label>网址</label>
        <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} data-name="browser.bookmark-edit-url-input" />
        <div className="browser-bookmark-edit-dialog-actions" data-name="browser.bookmark-edit-actions">
          <button type="button" className="cancel" onClick={onCancel} data-name="browser.bookmark-edit-cancel">取消</button>
          <button type="button" className="save" onClick={() => onSave(title, url)} data-name="browser.bookmark-edit-save">保存</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
