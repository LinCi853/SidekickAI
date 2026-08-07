/* =====================================================================
   pages/BrowserView/BookmarksBar/BookmarkContextMenu.tsx —— 书签右键菜单（v0.0.9）
   9 项：在新标签打开 / 修改(Modal 弹窗) / 剪切 / 复制 / 粘贴 / 删除 /
        是否显示到书签栏 / 是否展示书签栏 / 书签管理器
   ===================================================================== */

import { useState, type CSSProperties } from 'react';

import Popover, { PopoverItem, PopoverDivider } from '../../../components/ui/Popover';
import { Button, FormRow, Modal } from '../../../components/ui';
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

/** 书签编辑弹窗（使用共享 Modal 组件，ESC + 遮罩点击关闭由 Modal 自动处理；portal 渲染到 body 覆盖整个 browser.container） */
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

  // Modal 内部已处理 ESC 与遮罩点击关闭，无需手动监听
  const inputStyle: CSSProperties = {
    width: '100%',
    background: 'var(--card)',
    border: '1px solid var(--border)',
    color: 'var(--foreground)',
    padding: '6px 10px',
    borderRadius: 'var(--radius-sm)',
    fontSize: 'var(--text-sm)',
    outline: 'none',
    boxSizing: 'border-box',
  };

  return (
    <Modal
      open={true}
      onClose={onCancel}
      title="修改书签"
      portal
      className="browser-bookmark-edit-modal"
      data-name="browser.bookmark-edit-dialog"
    >
      <FormRow label="名称" stack data-name="browser.bookmark-edit-title-row">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
          style={inputStyle}
          data-name="browser.bookmark-edit-title-input"
        />
      </FormRow>
      <FormRow label="网址" stack data-name="browser.bookmark-edit-url-row">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={inputStyle}
          data-name="browser.bookmark-edit-url-input"
        />
      </FormRow>
      <div
        style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-1)', marginTop: 'var(--space-3)' }}
        data-name="browser.bookmark-edit-actions"
      >
        <Button type="button" variant="outline" onClick={onCancel} data-name="browser.bookmark-edit-cancel">取消</Button>
        <Button type="button" variant="primary" onClick={() => onSave(title, url)} data-name="browser.bookmark-edit-save">保存</Button>
      </div>
    </Modal>
  );
}
