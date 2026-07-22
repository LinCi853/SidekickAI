import type { MutableRefObject } from 'react';
import type { AIPlatform, Profile, TopBarButtonGroup } from '../../lib/electron-api';
import AppSwitcher from '../../components/AppSwitcher';
import { IconButton } from '../../components/ui';
import {
  minimizeWindow,
  closeCurrentWindow,
} from '../../lib/electron-api';

/* =====================================================================
   TopBar —— 顶栏（AppSwitcher + 导航 + 居中标题 + 菜单/置顶/窗口控制）
   纯 UI 子组件，所有状态留在 index.tsx，通过 props 传递。
   ===================================================================== */

export interface TopBarData {
  /** 是否正在编辑标题 */
  editingTitle: boolean;
  /** 标题输入框草稿 */
  titleDraft: string;
  /** 是否置顶 */
  alwaysOnTop: boolean;
  /** 是否最大化 */
  isMaximized: boolean;
  /** 当前激活标签标题（无标签时显示默认值） */
  activeTitle: string;
  /** 是否存在激活标签（控制导航按钮 disabled） */
  hasActiveTab: boolean;
  /** 当前 webview 是否可后退（无更靠前地址时为 false，按钮灰显） */
  canGoBack: boolean;
  /** 当前 webview 是否可前进（无更靠后地址时为 false，按钮灰显） */
  canGoForward: boolean;
  /** 当前激活 webview 是否 dom-ready（未就绪/崩溃恢复中禁用刷新与主页按钮，避免 ERR_FAILED） */
  activeTabDomReady: boolean;
  /** 标题输入框 ref */
  titleInputRef: MutableRefObject<HTMLInputElement | null>;
  /** 已过滤的 AI 平台列表（透传给 AppSwitcher，与底栏保持一致） */
  platforms: AIPlatform[];
  /** 当前是否为暗色主题（控制主题切换按钮图标） */
  isDark: boolean;
  /** 当前窗口是否为窄屏（用于标题编辑态紧凑判断） */
  isNarrow: boolean;
  /** 当前激活标签对应的 Profile 的 UA 锁定模式（无激活标签时为 undefined） */
  uaLockMode: 'auto' | 'mobile' | 'desktop' | undefined;
  /** 是否存在激活标签（控制 UA 按钮禁用态） */
  hasActiveProfile: boolean;
  /** 顶栏可见按钮组（未列出的隐藏；最小化/最大化/关闭始终显示） */
  visibleButtons: TopBarButtonGroup[];
  /** 点击内置 AI 平台的回调（透传给 AppSwitcher，统一走 handleAppClick 逻辑） */
  onAppClick?: (profile: Profile) => void;
  /** 点击已打开应用时的行为：switch=跳转 / close=关闭（透传给 AppSwitcher） */
  appClickBehavior: 'switch' | 'close';
  /** 当前激活标签对应的 profileId（透传给 AppSwitcher，用于 close 模式二次确认） */
  activeProfileId: string | null;
}

export interface TopBarActions {
  startEditTitle: () => void;
  commitTitle: () => void;
  setTitleDraft: (v: string) => void;
  setEditingTitle: (v: boolean) => void;
  handleGoBack: () => void;
  handleGoForward: () => void;
  handleReload: () => void;
  handleGoHome: () => void;
  handleMaximize: () => void;
  /** 切换置顶（走 store action，同步图标/高亮 + IPC + 持久化） */
  handleTogglePin: () => void;
  setDrawerOpen: (v: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
  /** 切换主题（light/dark） */
  onToggleTheme: () => void;
  /** 循环切换 UA 锁定模式：auto→mobile→desktop→auto */
  onToggleUaLockMode: () => void;
}

export interface TopBarProps {
  data: TopBarData;
  actions: TopBarActions;
}

export default function TopBar({ data, actions }: TopBarProps) {
  const {
    editingTitle,
    titleDraft,
    alwaysOnTop,
    isMaximized,
    activeTitle,
    hasActiveTab,
    canGoBack,
    canGoForward,
    activeTabDomReady,
    titleInputRef,
    platforms,
    isDark,
    isNarrow,
    uaLockMode,
    hasActiveProfile,
    visibleButtons,
    onAppClick,
    appClickBehavior,
    activeProfileId,
  } = data;
  const {
    startEditTitle,
    commitTitle,
    setTitleDraft,
    setEditingTitle,
    handleGoBack,
    handleGoForward,
    handleReload,
    handleGoHome,
    handleMaximize,
    handleTogglePin,
    setDrawerOpen,
    setSettingsOpen,
    onToggleTheme,
    onToggleUaLockMode,
  } = actions;

  // 标题编辑态紧凑模式：编辑中且（窄屏 或 窗口宽度 < 720）时启用
  // 隐藏导航按钮组与部分右侧操作按钮，标题输入区占满顶栏
  const compactTitleEdit =
    editingTitle && (isNarrow || (typeof window !== 'undefined' && window.innerWidth < 720));

  // UA 锁定模式：未定义视为 'auto'
  const uaMode = uaLockMode ?? 'auto';
  const uaLabel = uaMode === 'auto' ? 'UA 自动' : uaMode === 'mobile' ? 'UA 移动端' : 'UA 桌面端';

  return (
    <div className="top-bar" data-title-edit={compactTitleEdit ? 'compact' : undefined} style={{ position: 'relative' }} data-name="main.top-bar.container">
      {/* 左：AppSwitcher（常驻）+ UA 切换 + 导航按钮组（后退/前进/刷新/主页） */}
      <AppSwitcher
        platforms={platforms}
        onOpenSettings={() => setSettingsOpen(true)}
        onAppClick={onAppClick}
        appClickBehavior={appClickBehavior}
        activeProfileId={activeProfileId}
      />

      {/* UA 锁定三态切换按钮：auto / mobile / desktop */}
      <IconButton
        type="button"
        className="ua-toggle-btn"
        variant={uaMode !== 'auto' ? 'active' : 'default'}
        aria-label={uaLabel}
        title={uaLabel}
        disabled={!hasActiveProfile}
        onClick={onToggleUaLockMode}
        hidden={!visibleButtons.includes('uaToggle')}
        data-name="main.top-bar.ua-toggle-icon-button"
      >
        {uaMode === 'auto' ? (
          // 自动：显示器 + 手机组合
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="main.top-bar.ua-toggle-icon-auto">
            <rect x="2" y="3" width="14" height="11" rx="1" />
            <path d="M8 17h2" />
            <rect x="16" y="8" width="6" height="11" rx="1" />
            <path d="M19 16h.01" />
          </svg>
        ) : uaMode === 'mobile' ? (
          // 移动端：手机
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="main.top-bar.ua-toggle-icon-mobile">
            <rect x="7" y="2" width="10" height="20" rx="2" />
            <path d="M11 18h2" />
          </svg>
        ) : (
          // 桌面端：显示器
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="main.top-bar.ua-toggle-icon-desktop">
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <path d="M8 21h8M12 17v4" />
          </svg>
        )}
      </IconButton>

      <div className="nav-btn-group" data-name="main.top-bar.nav-group">
        <IconButton
          type="button"
          aria-label="后退"
          title="后退"
          disabled={!hasActiveTab || !canGoBack}
          onClick={handleGoBack}
          hidden={!visibleButtons.includes('navBack')}
          data-name="main.top-bar.nav-back-icon-button"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="main.top-bar.nav-back-icon">
            <path d="M19 12H5" />
            <path d="M12 19l-7-7 7-7" />
          </svg>
        </IconButton>
        <IconButton
          type="button"
          aria-label="前进"
          title="前进"
          disabled={!hasActiveTab || !canGoForward}
          onClick={handleGoForward}
          hidden={!visibleButtons.includes('navForward')}
          data-name="main.top-bar.nav-forward-icon-button"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="main.top-bar.nav-forward-icon">
            <path d="M5 12h14" />
            <path d="M12 5l7 7-7 7" />
          </svg>
        </IconButton>
      </div>

      {/* 刷新按钮（常驻，不随导航组隐藏） */}
      <IconButton
        type="button"
        aria-label="刷新"
        title="刷新"
        disabled={!hasActiveTab}
        onClick={handleReload}
        data-name="main.top-bar.refresh-icon-button"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="main.top-bar.refresh-icon">
          <path d="M23 4v6h-6" />
          <path d="M1 20v-6h6" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
      </IconButton>

      {/* 主页按钮（独立显隐） */}
      <IconButton
        type="button"
        aria-label="主页"
        title="主页"
        disabled={!hasActiveTab}
        onClick={handleGoHome}
        hidden={!visibleButtons.includes('navHome')}
        data-name="main.top-bar.home-icon-button"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="main.top-bar.home-icon">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      </IconButton>

      {/* 中：标题（绝对居中，双击编辑；编辑态显示输入框替换标题位置） */}
      <div className="top-bar-drag" data-name="main.top-bar.drag-region">
        {editingTitle ? (
          <input
            ref={titleInputRef}
            className="top-bar-title-input"
            value={titleDraft}
            spellCheck={false}
            autoFocus
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitTitle();
              } else if (e.key === 'Escape') {
                setEditingTitle(false);
              }
            }}
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              transform: 'translate(-50%, -50%)',
              zIndex: 100,
            }}
            data-name="main.top-bar.title-input"
          />
        ) : (
          <span
            className="top-bar-title"
            title="双击重命名"
            onDoubleClick={startEditTitle}
            data-name="main.top-bar.title"
          >
            {activeTitle}
          </span>
        )}
      </div>

      {/* 右：三点菜单（常驻）+ 笔记 + 置顶 + 分隔符 + 最小化/最大化/关闭 */}
      <div className="top-bar-actions" data-name="main.top-bar.actions-group">
        <IconButton
          type="button"
          data-dom-id="aw-main-menu-btn"
          aria-label="菜单"
          title="菜单"
          onClick={() => setDrawerOpen(true)}
          data-name="main.top-bar.menu-icon-button"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="main.top-bar.menu-icon">
            <circle cx="12" cy="5" r="1.5" />
            <circle cx="12" cy="12" r="1.5" />
            <circle cx="12" cy="19" r="1.5" />
          </svg>
        </IconButton>

        <IconButton
          type="button"
          data-dom-id="aw-main-theme-toggle-btn"
          variant={isDark ? 'active' : 'default'}
          aria-label="切换主题"
          title="切换主题 (F10)"
          onClick={onToggleTheme}
          hidden={!visibleButtons.includes('themeToggle')}
          data-name="main.top-bar.theme-icon-button"
        >
          {isDark ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="main.top-bar.theme-icon-dark">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="main.top-bar.theme-icon-light">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
        </IconButton>

        <IconButton
          type="button"
          variant={alwaysOnTop ? 'active' : 'default'}
          aria-label="置顶"
          title={alwaysOnTop ? '取消置顶' : '置顶'}
          onClick={handleTogglePin}
          hidden={!visibleButtons.includes('pinToggle')}
          data-name="main.top-bar.pin-icon-button"
        >
          <svg viewBox="0 0 24 24" fill={alwaysOnTop ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="main.top-bar.pin-icon">
            <line x1="12" y1="17" x2="12" y2="3" />
            <path d="M6.5 8.5L12 3l5.5 5.5" />
            <path d="M5 21h14" />
          </svg>
        </IconButton>

        <div className="top-bar-separator" data-name="main.top-bar.separator-divider" />

        <IconButton
          type="button"
          aria-label="最小化"
          title="最小化"
          onClick={() => void minimizeWindow()}
          data-name="main.top-bar.minimize-icon-button"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" data-name="main.top-bar.minimize-icon">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </IconButton>
        <IconButton
          type="button"
          aria-label={isMaximized ? '还原' : '最大化'}
          title={isMaximized ? '还原' : '最大化'}
          onClick={() => void handleMaximize()}
          data-name="main.top-bar.maximize-icon-button"
        >
          {isMaximized ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="main.top-bar.maximize-icon-restore">
              <rect x="9" y="9" width="11" height="11" rx="1" />
              <path d="M5 15V5a2 2 0 0 1 2-2h10" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="main.top-bar.maximize-icon-maximize">
              <rect x="4" y="4" width="16" height="16" rx="1" />
            </svg>
          )}
        </IconButton>
        <IconButton
          type="button"
          variant="close"
          aria-label="关闭"
          title="关闭"
          onClick={() => void closeCurrentWindow()}
          data-name="main.top-bar.close-icon-button"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" data-name="main.top-bar.close-icon">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </IconButton>
      </div>
    </div>
  );
}
