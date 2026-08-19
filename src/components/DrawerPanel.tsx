/* =====================================================================
   components/DrawerPanel.tsx —— 三点菜单抽屉面板（v2 设计）
   右侧滑入 280px，含：搜索框 + 功能列表（搜索历史/快捷键/设置/提示词）+ 页脚提示
   ===================================================================== */

import { useCallback, useEffect, useRef } from 'react';
import Sun from 'lucide-react/dist/esm/icons/sun'
import Moon from 'lucide-react/dist/esm/icons/moon'
import { useThemeStore } from '../store/useThemeStore';
import { useModuleStore } from '../store/useModuleStore';
import { useUiVersionStore } from '../store/useUiVersionStore';
import { openAdvancedPanelWindow, showOnboardingWindow } from '../lib/electron-api';
import { IconButton } from './ui';
import { useEscToCloseOverlay } from '../hooks/useEscToCloseWindow';
import './DrawerPanel.css';

export interface DrawerPanelProps {
  open: boolean;
  onClose: () => void;
  onOpenSearch?: () => void;
  onOpenShortcuts?: () => void;
  onOpenSettings?: () => void;
  onOpenPromptLibrary?: () => void;
}

export default function DrawerPanel({
  open,
  onClose,
  onOpenSearch,
  onOpenShortcuts,
  onOpenSettings,
  onOpenPromptLibrary,
}: DrawerPanelProps) {
  const theme = useThemeStore((s) => s.theme);
  const resolved = useThemeStore((s) => s.resolved);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  // 模块门控：提示词库入口 / 进阶面板入口（chat+白板+笔记全关时隐藏）
  const promptEnabled = useModuleStore((s) => s.isEnabled('prompt-library'));
  const advancedPanelAvailable = useModuleStore(
    (s) => s.isEnabled('custom-chat') || s.isEnabled('whiteboard') || s.isEnabled('notes'),
  );
  const isOxy = useUiVersionStore((s) => s.version) === 'oxy';

  // 关闭时设置 inert，防止 Tab 焦点泄漏到隐藏的抽屉面板
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (panelRef.current) {
      if (open) panelRef.current.removeAttribute('inert');
      else panelRef.current.setAttribute('inert', '');
    }
  }, [open]);

  const handleOpenAdvancedPanel = useCallback(() => {
    void openAdvancedPanelWindow().catch((e) =>
      console.error('[DrawerPanel] 打开 进阶面板失败:', e),
    );
    onClose();
  }, [onClose]);

  const handleOpenOnboarding = useCallback(() => {
    void showOnboardingWindow().catch((e) =>
      console.error('[DrawerPanel] 打开使用指南失败:', e),
    );
    onClose();
  }, [onClose]);

  const handleItemClick = useCallback(
    (action: 'search' | 'shortcuts' | 'settings' | 'prompt') => {
      switch (action) {
        case 'search':
          onOpenSearch?.();
          break;
        case 'shortcuts':
          onOpenShortcuts?.();
          break;
        case 'settings':
          onOpenSettings?.();
          break;
        case 'prompt':
          onOpenPromptLibrary?.();
          break;
      }
      onClose();
    },
    [onOpenSearch, onOpenShortcuts, onOpenSettings, onOpenPromptLibrary, onClose],
  );

  // ESC：关闭抽屉（加入全局浮窗栈，与其他浮窗统一优先级管理）
  useEscToCloseOverlay(open, onClose);

  // 打开时监听快捷键：K=搜索，?=快捷键，,=设置，P=提示词库（ESC 由 useEscToCloseOverlay 处理）
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // 输入框聚焦时不触发
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      // 仅在无修饰键时触发
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const key = e.key.toLowerCase();
      if (key === 'k') {
        e.preventDefault();
        handleItemClick('search');
      } else if (key === '?' || key === '/') {
        e.preventDefault();
        handleItemClick('shortcuts');
      } else if (key === ',') {
        e.preventDefault();
        handleItemClick('settings');
      } else if (key === 'p') {
        e.preventDefault();
        if (promptEnabled) handleItemClick('prompt');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, handleItemClick, promptEnabled]);

  return (
    <>
      <div
        className={`drawer-overlay${open ? ' active' : ''}`}
        data-name="component.drawer-panel.overlay"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        className={`drawer-panel${open ? ' active' : ''}`}
        data-dom-id="aw-main-drawer"
        data-name="component.drawer-panel.container"
        role="dialog"
        aria-label="菜单"
      >
        <div className="drawer-header" data-name="component.drawer-panel.header">
          <span className="drawer-header-title" data-name="component.drawer-panel.title">菜单</span>
          <IconButton
            type="button"
            variant="close"
            className="drawer-close-btn"
            data-name="component.drawer-panel.close-button"
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              data-name="component.drawer-panel.close-icon"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </IconButton>
        </div>

        <button
          type="button"
          className="drawer-search"
          data-name="component.drawer-panel.search-button"
          onClick={() => handleItemClick('search')}
          title="搜索对话或提示词"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            data-name="component.drawer-panel.search-icon"
            style={{ color: 'var(--muted-foreground)', flexShrink: 0 }}
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <span className="drawer-search-input" data-name="component.drawer-panel.search-input" style={{ cursor: 'default' }}>
            搜索对话或提示词...
          </span>
          <span className="drawer-kbd" data-name="component.drawer-panel.search-kbd">K</span>
        </button>

        <div className="drawer-list" data-name="component.drawer-panel.list">
          {/* 进阶面板入口（Alt+Q）—— chat/白板/笔记全关时隐藏 */}
          {advancedPanelAvailable && (
          <button
            type="button"
            className="drawer-item"
            data-name="component.drawer-panel.advanced-panel-button"
            onClick={handleOpenAdvancedPanel}
            title="打开进阶面板（Alt+Q）"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              data-name="component.drawer-panel.advanced-panel-icon"
            >
              <path d="M12 8V4H8" />
              <rect width="16" height="12" x="4" y="8" rx="2" />
              <path d="M2 14h2" />
              <path d="M20 14h2" />
              <path d="M15 13v2" />
              <path d="M9 13v2" />
            </svg>
            <span data-name="component.drawer-panel.advanced-panel-label">进阶面板</span>
            <span className="drawer-item-shortcut" data-name="component.drawer-panel.advanced-panel-shortcut">Alt+Q</span>
          </button>
          )}

          {/* 使用指南入口 */}
          <button
            type="button"
            className="drawer-item"
            data-name="component.drawer-panel.onboarding-button"
            onClick={handleOpenOnboarding}
            title="查看功能介绍与使用指南"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              data-name="component.drawer-panel.onboarding-icon"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <path d="M12 17h.01" />
            </svg>
            <span data-name="component.drawer-panel.onboarding-label">使用指南</span>
            <span className="drawer-item-shortcut" data-name="component.drawer-panel.onboarding-shortcut">?</span>
          </button>

          {/* 分隔 */}
          <div className="drawer-divider" data-name="component.drawer-panel.divider" />

          <button
            type="button"
            className="drawer-item"
            data-dom-id="aw-main-search-btn"
            data-name="component.drawer-panel.search-history-button"
            onClick={() => handleItemClick('search')}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              data-name="component.drawer-panel.search-history-icon"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <span data-name="component.drawer-panel.search-history-label">搜索历史</span>
            <span className="drawer-item-shortcut" data-name="component.drawer-panel.search-history-shortcut">K</span>
          </button>
          <button
            type="button"
            className="drawer-item"
            data-dom-id="aw-main-shortcuts-btn"
            data-name="component.drawer-panel.shortcuts-button"
            onClick={() => handleItemClick('shortcuts')}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              data-name="component.drawer-panel.shortcuts-icon"
            >
              <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <span data-name="component.drawer-panel.shortcuts-label">快捷键提示</span>
            <span className="drawer-item-shortcut" data-name="component.drawer-panel.shortcuts-shortcut">?</span>
          </button>
          <button
            type="button"
            className="drawer-item"
            data-dom-id="aw-main-settings-btn"
            data-name="component.drawer-panel.settings-button"
            onClick={() => handleItemClick('settings')}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              data-name="component.drawer-panel.settings-icon"
            >
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <span data-name="component.drawer-panel.settings-label">设置</span>
            <span className="drawer-item-shortcut" data-name="component.drawer-panel.settings-shortcut">,</span>
          </button>
          {promptEnabled && (
          <button
            type="button"
            className="drawer-item"
            data-dom-id="aw-main-prompt-btn"
            data-name="component.drawer-panel.prompt-library-button"
            onClick={() => handleItemClick('prompt')}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              data-name="component.drawer-panel.prompt-library-icon"
            >
              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              <path d="m15 5 4 4" />
            </svg>
            <span data-name="component.drawer-panel.prompt-library-label">提示词库</span>
            <span className="drawer-item-shortcut" data-name="component.drawer-panel.prompt-library-shortcut">P</span>
          </button>
          )}
          {!isOxy && (
          <button
            type="button"
            className="drawer-item"
            data-dom-id="aw-main-theme-btn"
            data-name="component.drawer-panel.theme-button"
            onClick={toggleTheme}
            title={resolved === 'dark' ? '切换到亮色模式' : '切换到暗色模式'}
          >
            {resolved === 'dark'
              ? <Moon data-name="component.drawer-panel.theme-icon-dark" />
              : <Sun data-name="component.drawer-panel.theme-icon-light" />}
            <span data-name="component.drawer-panel.theme-label">切换主题</span>
            <span className="drawer-item-shortcut" data-name="component.drawer-panel.theme-shortcut">{theme === 'system' ? '跟随系统' : resolved === 'dark' ? '暗色' : '亮色'}</span>
          </button>
          )}
        </div>

        <div className="drawer-footer" data-name="component.drawer-panel.footer">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            data-name="component.drawer-panel.footer-icon"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4" />
            <path d="M12 8h.01" />
          </svg>
          <span data-name="component.drawer-panel.footer-text">Alt+Space 呼出/隐藏窗口</span>
        </div>
      </div>
    </>
  );
}
