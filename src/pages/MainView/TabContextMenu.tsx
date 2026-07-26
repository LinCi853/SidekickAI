import { useEffect } from 'react';
import type { MutableRefObject } from 'react';
import type { WebviewElement } from '../../lib/webview';

/* =====================================================================
   TabContextMenu —— 标签右键菜单（地址编辑 / 页面操作 / 首页设置 / 标签管理）
   纯 UI 子组件，所有状态留在 index.tsx，通过 props 传递。
   ===================================================================== */

// 右键菜单动作回调集合（统一对象，避免 props 数量过多）
export interface TabContextMenuActions {
  // 标签操作（接收 tabId）
  refresh: (tabId: string) => void;
  clearData: (tabId: string) => void;
  setAsHome: (tabId: string) => void;
  configureApp: (tabId: string) => void;
  // 需求 12：截图当前 webview 页面到白板（生成 image 卡片）
  screenshotToWhiteboard: (tabId: string) => void;
  detach: (tabId: string) => void;
  closeOthers: (tabId: string) => void;
  closeRight: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  // URL 编辑
  commitUrl: () => void;
  setUrlDraft: (v: string) => void;
  setEditingUrl: (v: boolean) => void;
  // 关闭菜单
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

  // ESC 关闭菜单（URL 编辑输入框聚焦时由输入框自行处理 ESC 退出编辑，不关菜单）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close]);

  return (
    <>
      <div
        className="settings-overlay"
        style={{ opacity: 1, pointerEvents: 'auto', zIndex: 199 }}
        onClick={close}
        aria-hidden="true"
        data-name="main.tab-context-menu.overlay"
      />
      <div
        className="tab-context-menu"
        style={{ left: position.x, top: position.y }}
        data-name="main.tab-context-menu.menu"
      >
        {/* 当前地址 */}
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
              <div className="tab-context-menu-url" data-name="main.tab-context-menu.url-display">{urlDraft || '（未设置）'}</div>
              <button
                type="button"
                className="tab-context-menu-item"
                onClick={() => {
                  setEditingUrl(true);
                  requestAnimationFrame(() => urlInputRef.current?.select());
                }}
                data-name="main.tab-context-menu.menu-item-1"
              >
                <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="main.tab-context-menu.menu-item-1-icon">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
                <span data-name="main.tab-context-menu.menu-item-1-label">修改地址</span>
              </button>
              <button
                type="button"
                className="tab-context-menu-item"
                onClick={() => {
                  navigator.clipboard?.writeText(urlDraft).catch(() => {});
                  close();
                }}
                data-name="main.tab-context-menu.menu-item-2"
              >
                <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="main.tab-context-menu.menu-item-2-icon">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                <span data-name="main.tab-context-menu.menu-item-2-label">复制地址</span>
              </button>
            </>
          )}
        </div>

        {/* 页面操作 */}
        <div className="tab-context-menu-section" data-name="main.tab-context-menu.section-2">
          <div className="tab-context-menu-label" data-name="main.tab-context-menu.section-2-label">页面操作</div>
          <button
            type="button"
            className="tab-context-menu-item"
            onClick={() => {
              refresh(tabId);
              close();
            }}
            data-name="main.tab-context-menu.menu-item-3"
          >
            <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="main.tab-context-menu.menu-item-3-icon">
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            <span data-name="main.tab-context-menu.menu-item-3-label">刷新页面</span>
          </button>
          <button
            type="button"
            className="tab-context-menu-item"
            onClick={() => {
              const webview = document.querySelector(`webview[data-tab-id="${tabId}"]`) as WebviewElement | null;
              if (webview && homeUrl) webview.loadURL(homeUrl);
              close();
            }}
            data-name="main.tab-context-menu.menu-item-4"
          >
            <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="main.tab-context-menu.menu-item-4-icon">
              <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
            <span data-name="main.tab-context-menu.menu-item-4-label">回到首页</span>
          </button>
          <button
            type="button"
            className="tab-context-menu-item danger"
            onClick={() => {
              void clearData(tabId);
              close();
            }}
            data-name="main.tab-context-menu.menu-item-5"
          >
            <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="main.tab-context-menu.menu-item-5-icon">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6" />
              <path d="M14 11v6" />
              <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
            </svg>
            <span data-name="main.tab-context-menu.menu-item-5-label">清除数据并刷新</span>
          </button>
          <button
            type="button"
            className="tab-context-menu-item"
            onClick={() => {
              void screenshotToWhiteboard(tabId);
              close();
            }}
            data-name="main.tab-context-menu.menu-item-5b"
          >
            <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="main.tab-context-menu.menu-item-5b-icon">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
            <span data-name="main.tab-context-menu.menu-item-5b-label">截图到白板</span>
          </button>
        </div>

        {/* 首页设置 */}
        <div className="tab-context-menu-section" data-name="main.tab-context-menu.section-3">
          <div className="tab-context-menu-label" data-name="main.tab-context-menu.section-3-label">应用设置</div>
          {isAiPlatformTab && (
            <button
              type="button"
              className="tab-context-menu-item"
              onClick={() => {
                configureApp(tabId);
                close();
              }}
              data-name="main.tab-context-menu.menu-item-6"
            >
              <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="main.tab-context-menu.menu-item-6-icon">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span data-name="main.tab-context-menu.menu-item-6-label">配置此 AI 应用</span>
            </button>
          )}
          <button
            type="button"
            className="tab-context-menu-item"
            onClick={() => {
              void setAsHome(tabId);
              close();
            }}
            data-name="main.tab-context-menu.menu-item-7"
          >
            <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="main.tab-context-menu.menu-item-7-icon">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
            <span data-name="main.tab-context-menu.menu-item-7-label">设为当前 AI 首页</span>
          </button>
        </div>

        {/* 标签管理 */}
        <div className="tab-context-menu-section" data-name="main.tab-context-menu.section-4">
          <div className="tab-context-menu-label" data-name="main.tab-context-menu.section-4-label">标签管理</div>
          <button
            type="button"
            className="tab-context-menu-item"
            onClick={() => {
              void detach(tabId);
              close();
            }}
            data-name="main.tab-context-menu.menu-item-8"
          >
            <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="main.tab-context-menu.menu-item-8-icon">
              <path d="M15 3h6v6" />
              <path d="M10 14L21 3" />
              <path d="M21 14v7H3V3h7" />
            </svg>
            <span data-name="main.tab-context-menu.menu-item-8-label">复制为独立窗口</span>
          </button>
          <button
            type="button"
            className="tab-context-menu-item"
            onClick={() => {
              closeOthers(tabId);
              close();
            }}
            data-name="main.tab-context-menu.menu-item-9"
          >
            <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="main.tab-context-menu.menu-item-9-icon">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="9" x2="15" y2="15" />
              <line x1="15" y1="9" x2="9" y2="15" />
            </svg>
            <span data-name="main.tab-context-menu.menu-item-9-label">关闭其他标签</span>
          </button>
          <button
            type="button"
            className="tab-context-menu-item"
            onClick={() => {
              closeRight(tabId);
              close();
            }}
            data-name="main.tab-context-menu.menu-item-10"
          >
            <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="main.tab-context-menu.menu-item-10-icon">
              <polyline points="9 18 15 12 9 6" />
            </svg>
            <span data-name="main.tab-context-menu.menu-item-10-label">关闭右侧标签</span>
          </button>
          <button
            type="button"
            className="tab-context-menu-item danger"
            onClick={() => {
              void closeTab(tabId);
              close();
            }}
            data-name="main.tab-context-menu.menu-item-11"
          >
            <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="main.tab-context-menu.menu-item-11-icon">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
            <span data-name="main.tab-context-menu.menu-item-11-label">关闭当前标签</span>
          </button>
        </div>
      </div>
    </>
  );
}
