/* =====================================================================
   components/ShortcutsModal.tsx —— 快捷键速查弹窗（扁平列表，颜色分两类）
   所有页面均可呼出（` / ~ / ?，或页面内按钮，或 webview 焦点时主进程
   openShortcuts 转发）。内容来自快捷键注册表（store/useShortcutDocStore）：
   各行为实现在注册键位时已一并声明说明，页面打开时完成扫描、数据常备，
   弹窗只读快照渲染。

   展示规则：
   - 仅两类：全局 / 页面内，只用键位颜色区分（全局 accent、页面内 info），
     不加分类行、不加 badge 列
   - 全局条目排前、页面条目在后；禁用条目灰显并标注「已禁用」
   - 头部徽标标明当前页面（内容随页面实时变化）
   ===================================================================== */

import './ShortcutsModal.css';
import { useMemo } from 'react';
import { IconButton } from './ui';
import { useEscToCloseOverlay } from '../hooks/useEscToCloseWindow';
import { useShortcutDocStore, selectShortcutDocs } from '../store/useShortcutDocStore';
import { getShortcutPageId, SHORTCUT_PAGE_TITLES } from '../lib/shortcut-reference';
import type { ShortcutPageId } from '../lib/shortcut-reference';

export interface ShortcutsModalProps {
  open: boolean;
  onClose: () => void;
  /** 页面 ID（默认按当前 URL 推导；测试或特殊场景可显式传入） */
  pageId?: ShortcutPageId;
}

export default function ShortcutsModal({ open, onClose, pageId }: ShortcutsModalProps) {
  // ESC 关闭快捷键说明面板
  useEscToCloseOverlay(open, onClose);

  const resolvedPageId = pageId ?? getShortcutPageId();
  const pageTitle = SHORTCUT_PAGE_TITLES[resolvedPageId];
  const sources = useShortcutDocStore((s) => s.sources);
  const docs = useMemo(() => selectShortcutDocs(sources), [sources]);

  return (
    <div
      className={`shortcuts-overlay${open ? ' is-open' : ''}`}
      data-name="component.shortcuts-modal.overlay"
      onClick={onClose}
      aria-hidden={!open}
    >
      <div
        className="shortcuts-modal"
        role="dialog"
        aria-label={`快捷键（${pageTitle}）`}
        data-name="component.shortcuts-modal.modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shortcuts-header" data-name="component.shortcuts-modal.modal-header">
          <h2 data-name="component.shortcuts-modal.title">
            快捷键
            <span className="shortcuts-page-badge" data-name="component.shortcuts-modal.page-badge">
              {pageTitle}
            </span>
          </h2>
          <IconButton
            type="button"
            variant="close"
            className="shortcuts-close"
            data-name="component.shortcuts-modal.close-button"
            aria-label="关闭"
            onClick={onClose}
          >
            <svg
              className="icon-svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              data-name="component.shortcuts-modal.close-icon"
            >
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </IconButton>
        </div>
        <div className="shortcuts-body" data-name="component.shortcuts-modal.modal-body">
          <div className="shortcuts-list" role="list" data-name="component.shortcuts-modal.list">
            {docs.map((s) => (
              <div
                className={`shortcuts-item${s.disabled ? ' is-disabled' : ''}`}
                role="listitem"
                key={s.id}
                data-name={`component.shortcuts-modal.item-${s.id}`}
                data-id={s.id}
                data-category={s.category}
              >
                <div
                  className={`shortcuts-keys is-${s.category}`}
                  data-name={`component.shortcuts-modal.item-keys-${s.id}`}
                >
                  {s.keys}
                </div>
                <div className="shortcuts-action" data-name={`component.shortcuts-modal.item-action-${s.id}`}>
                  <span className="shortcuts-action-text" data-name={`component.shortcuts-modal.item-action-text-${s.id}`}>
                    {s.action}
                    {s.disabled && <span className="shortcuts-disabled-tag" data-name={`component.shortcuts-modal.item-disabled-tag-${s.id}`}>（已禁用）</span>}
                  </span>
                  {s.note && <div className="shortcuts-note" data-name={`component.shortcuts-modal.item-note-${s.id}`}>{s.note}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
