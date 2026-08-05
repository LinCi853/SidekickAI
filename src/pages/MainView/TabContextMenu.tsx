import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import Popover, { PopoverItem, PopoverDivider } from '../../components/ui/Popover';
import type { WebviewElement } from '../../lib/webview';

/* =====================================================================
   TabContextMenu —— 标签右键菜单（地址编辑 / 页面操作 / 首页设置 / 标签管理）
   使用 Popover 组件统一管理遮罩、ESC、点击外部关闭
   ===================================================================== */

// 右键菜单动作回调集合
export interface TabContextMenuActions {
  refresh: (tabId: string) => void;
  clearData: (tabId: string) => void;
  setAsHome: (tabId: string) => void;
  configureApp: (tabId: string) => void;
  screenshotToWhiteboard: (tabId: string) => void;
  detach: (tabId: string) => void;
  closeOthers: (tabId: string) => void;
  closeRight: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  commitUrl: () => void;
  setUrlDraft: (v: string) => void;
  setEditingUrl: (v: boolean) => void;
  close: () => void;
}

export interface TabContextMenuProps {
  position: { x: number; y: number };
  tabId: string;
  homeUrl: string;
  urlDraft: string;
  editingTabUrl: boolean;
  urlInputRef: MutableRefObject<HTMLInputElement | null>;
  isAiPlatformTab: boolean;
  actions: TabContextMenuActions;
}

export default function TabContextMenu({
  position,
  tabId,
  homeUrl,
  urlDraft,
  editingTabUrl,
  urlInputRef,
  isAiPlatformTab,
  actions,
}: TabContextMenuProps) {
  const {
    refresh,
    clearData,
    setAsHome,
    configureApp,
    screenshotToWhiteboard,
    detach,
    closeOthers,
    closeRight,
    closeTab,
    commitUrl,
    setUrlDraft,
    setEditingUrl,
    close,
  } = actions;

  // URL 编辑区域
  const renderUrlSection = () => (
    <div className="tab-context-menu-section" data-name="main.tab-context-menu.section-1">
      <div className="tab-context-menu-label" data-name="main.tab-context-menu.section-1-label">当前地址</div>
      {editingTabUrl ? (
        <>
          <input
            ref={urlInputRef}
            className="tab-context-menu-url-input"
            type="text"
            value={urlDraft}
            spellCheck={false}
            autoFocus
            onChange={(e) => setUrlDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitUrl();
              } else if (e.key === 'Escape') {
                setEditingUrl(false);
              }
            }}
            data-name="main.tab-context-menu.url-input"
          />
          <div className="tab-context-menu-actions" data-name="main.tab-context-menu.url-actions-group">
            <button
              type="button"
              className="tab-context-menu-cancel"
              onClick={() => setEditingUrl(false)}
              data-name="main.tab-context-menu.url-cancel-button"
            >
              取消
            </button>
            <button
              type="button"
              className="tab-context-menu-confirm"
              onClick={commitUrl}
              data-name="main.tab-context-menu.url-confirm-button"
            >
              确认
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="tab-context-menu-url" title={urlDraft || undefined} data-name="main.tab-context-menu.url-display">
            {urlDraft || '（未设置）'}
          </div>
          <PopoverItem
            onClick={() => {
              setEditingUrl(true);
              requestAnimationFrame(() => urlInputRef.current?.select());
            }}
            label="修改地址"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
            }
            dataName="main.tab-context-menu.menu-item-1"
          />
          <PopoverItem
            onClick={() => {
              navigator.clipboard?.writeText(urlDraft).catch(() => {});
              close();
            }}
            label="复制地址"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            }
            dataName="main.tab-context-menu.menu-item-2"
          />
        </>
      )}
    </div>
  );

  // 页面操作区域
  const renderPageActionsSection = () => (
    <div className="tab-context-menu-section" data-name="main.tab-context-menu.section-2">
      <div className="tab-context-menu-label" data-name="main.tab-context-menu.section-2-label">页面操作</div>
      <PopoverItem
        onClick={() => { refresh(tabId); close(); }}
        label="刷新页面"
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        }
        dataName="main.tab-context-menu.menu-item-3"
      />
      <PopoverItem
        onClick={() => { void clearData(tabId); close(); }}
        label="清除数据"
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        }
        dataName="main.tab-context-menu.menu-item-4"
      />
      <PopoverItem
        onClick={() => { void screenshotToWhiteboard(tabId); close(); }}
        label="截图到白板"
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
        }
        dataName="main.tab-context-menu.menu-item-5"
      />
    </div>
  );

  // AI 应用区域
  const renderAiAppSection = () => (
    <div className="tab-context-menu-section" data-name="main.tab-context-menu.section-3">
      <div className="tab-context-menu-label" data-name="main.tab-context-menu.section-3-label">AI 应用</div>
      {isAiPlatformTab && (
        <PopoverItem
          onClick={() => { void configureApp(tabId); close(); }}
          label="配置此 AI 应用"
          icon={
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          }
          dataName="main.tab-context-menu.menu-item-6"
        />
      )}
      <PopoverItem
        onClick={() => { void setAsHome(tabId); close(); }}
        label="设为当前 AI 首页"
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
        }
        dataName="main.tab-context-menu.menu-item-7"
      />
    </div>
  );

  // 标签管理区域
  const renderTabManagementSection = () => (
    <div className="tab-context-menu-section" data-name="main.tab-context-menu.section-4">
      <div className="tab-context-menu-label" data-name="main.tab-context-menu.section-4-label">标签管理</div>
      <PopoverItem
        onClick={() => { void detach(tabId); close(); }}
        label="独立为浏览器窗口"
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
        }
        dataName="main.tab-context-menu.menu-item-8"
      />
      <PopoverItem
        onClick={() => { closeOthers(tabId); close(); }}
        label="关闭其他标签"
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="9" x2="15" y2="15" />
            <line x1="15" y1="9" x2="9" y2="15" />
          </svg>
        }
        dataName="main.tab-context-menu.menu-item-9"
      />
      <PopoverItem
        onClick={() => { closeRight(tabId); close(); }}
        label="关闭右侧标签"
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        }
        dataName="main.tab-context-menu.menu-item-10"
      />
      <PopoverItem
        onClick={() => { void closeTab(tabId); close(); }}
        label="关闭当前标签"
        danger
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        }
        dataName="main.tab-context-menu.menu-item-11"
      />
    </div>
  );

  return (
    <Popover
      isOpen={true}
      onClose={close}
      position={position}
      variant="context-menu"
      config={{ closeOnOutsideClick: true, closeOnEsc: true }}
      style={{ width: 240 }}
      dataName="main.tab-context-menu"
    >
      {renderUrlSection()}
      {renderPageActionsSection()}
      {renderAiAppSection()}
      {renderTabManagementSection()}
    </Popover>
  );
}