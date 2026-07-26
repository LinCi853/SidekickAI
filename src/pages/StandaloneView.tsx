/* =====================================================================
   pages/StandaloneView.tsx —— 脱离窗口视图（单标签独立窗口）
   架构：
   - 顶栏（常驻）：可编辑标题 → 最小化/最大化/关闭/置顶
   - 中央：单个 <webview> 展示脱离标签的 AI 平台
   - 无底栏（单标签无需切换）
   - 窗口状态通过 useTabStore 持久化（bounds / alwaysOnTop / tabs）
   - Alt+Q 由主进程全局热键控制显隐（自定义窗口）
   ===================================================================== */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useHotkeys } from '../hooks/useHotkeys';
import WindowResizeHandles from '../components/WindowResizeHandles';
import SettingsPanel from '../components/SettingsPanel';
import ShortcutsModal from '../components/ShortcutsModal';
import { IconButton, TitleBar } from '../components/ui';
import { useProfileStore } from '../store/useProfileStore';
import { useTabStore } from '../store/useTabStore';
import {
  getFingerprintScript,
  minimizeWindow,
  maximizeToggleWindow,
  closeCurrentWindow,
  isWindowMaximized,
  pinCurrentWindow,
  getHotkeys,
} from '../lib/electron-api';
import type { Profile, HotkeyConfig } from '../lib/electron-api';
import { injectViewportAndPopupGuard, safeLoadURLWebview, type WebviewElement } from '../lib/webview';
import { useShortcutsToggle } from '../hooks/useShortcutsToggle';
import { useIsNarrow } from '../hooks/useIsNarrow';
import { useEscToCloseWindow } from '../hooks/useEscToCloseWindow';
import { listBlockRules } from '../lib/electron-api/block-rules';
import { buildBlockerScript, matchDomain } from '../lib/webview-blocker';
import './StandaloneView.css';

export default function StandaloneView() {
  // 从 TabStore 读取当前窗口状态（初始化已在 App.tsx 完成）
  const {
    tabs,
    activeTabId,
    isMaximized,
    alwaysOnTop,
    initialized,
    renameTab,
    setAlwaysOnTop,
    setMaximized,
  } = useTabStore();

  // 从 ProfileStore 读取 Profile 列表（已在 App.tsx 加载）
  const profiles = useProfileStore((s) => s.profiles);

  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  // ShortcutsModal 动态渲染全局热键（自定义 accelerator + 启用状态）
  const [hotkeys, setHotkeys] = useState<HotkeyConfig[]>([]);
  // 长宽自适应：< 600px 视为窄屏（导航/工具按钮隐藏）
  const isNarrow = useIsNarrow();

  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const webviewRef = useRef<WebviewElement | null>(null);

  useHotkeys({});

  // 反引号(` ~) / ? 呼出快捷键说明窗口（与主进程 before-input-event 拦截分支对应）
  useShortcutsToggle(isShortcutsOpen, setIsShortcutsOpen);

  // ShortcutsModal 打开时加载最新全局热键配置（自定义 accelerator + 启用状态）
  useEffect(() => {
    if (!isShortcutsOpen) return;
    getHotkeys()
      .then((list) => setHotkeys(list))
      .catch((e) => console.error('加载全局热键失败（ShortcutsModal）:', e));
  }, [isShortcutsOpen]);

  // 同步初始最大化态
  useEffect(() => {
    if (!initialized) return;
    isWindowMaximized()
      .then((m) => setMaximized(m))
      .catch((e) => console.warn('[standalone] 操作失败:', e));
  }, [initialized, setMaximized]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null;
  const activeProfile: Profile | null = activeTab
    ? profiles.find((p) => p.id === activeTab.profileId) ?? null
    : null;
  const activeTitle = activeTab?.title ?? '工百窗';

  // webview 指纹注入 + viewport + 弹窗拦截兜底 + 屏蔽规则注入
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview || !activeProfile) return;
    const handleDomReady = async () => {
      if (!activeProfile) return;
      try {
        const script = await getFingerprintScript(activeProfile.id);
        await webview.executeJavaScript(script);

        // 强制移动端 viewport，防止横向滚动/阴影；兜底拦截 window.open 与 _blank
        await injectViewportAndPopupGuard(webview);

        // 注入页面组件屏蔽规则（与 WebviewTab 保持一致，确保脱离窗口也享受广告屏蔽）
        try {
          const rules = await listBlockRules();
          const url = webview.getURL();
          const hostname = url ? new URL(url).hostname : '';
          if (hostname) {
            const matched = rules.filter((r) => r.enabled && matchDomain(r.domainPattern, hostname));
            console.log(
              `[StandaloneView] 屏蔽规则注入: hostname=${hostname} total=${rules.length} matched=${matched.length}`,
            );
            if (matched.length > 0) {
              await webview.executeJavaScript(buildBlockerScript(matched));
            }
          }
        } catch (e) {
          console.error('[StandaloneView] 屏蔽规则注入失败:', e);
        }
      } catch (e) {
        console.error('[StandaloneView] 注入失败:', e);
      }
    };
    webview.addEventListener('dom-ready', handleDomReady as EventListener);

    // webview 内快捷键拦截（F11 最大化 / F12 置顶 / ` ~ ? 呼出快捷键窗口），webview 获得焦点时也生效
    const handleBeforeInput = (e: Event) => {
      const inputEvent = e as unknown as {
        type: string;
        key: string;
        code?: string;
        modifiers: string[];
      };
      if (inputEvent.type !== 'keyDown') return;
      const mods = inputEvent.modifiers || [];
      const hasAlt = mods.includes('alt');
      const hasCtrl = mods.includes('control') || mods.includes('ctrl');
      const hasMeta = mods.includes('meta') || mods.includes('command');
      const hasShift = mods.includes('shift');
      if (inputEvent.key === 'F11') {
        e.preventDefault();
        useTabStore.getState().toggleMaximize();
        return;
      }
      if (inputEvent.key === 'F12') {
        e.preventDefault();
        useTabStore.getState().toggleAlwaysOnTop();
        return;
      }
      // Ctrl+W：关闭整个脱离窗口（webview 焦点时兜底，主进程已拦截但渲染层需自行处理关闭）
      if (hasCtrl && !hasAlt && !hasMeta && !hasShift && (inputEvent.key === 'w' || inputEvent.key === 'W')) {
        e.preventDefault();
        void closeCurrentWindow();
        return;
      }
      // 反引号(` ~) 或 Shift+? 呼出快捷键说明窗口
      if (!hasAlt && !hasCtrl && !hasMeta && !hasShift && (inputEvent.key === '`' || inputEvent.key === '~' || inputEvent.code === 'Backquote')) {
        e.preventDefault();
        setIsShortcutsOpen((prev) => !prev);
        return;
      }
      if (!hasAlt && !hasCtrl && !hasMeta && hasShift && inputEvent.key === '?') {
        e.preventDefault();
        setIsShortcutsOpen((prev) => !prev);
        return;
      }
    };
    webview.addEventListener('before-input-event', handleBeforeInput);

    return () => {
      webview.removeEventListener('dom-ready', handleDomReady as EventListener);
      webview.removeEventListener('before-input-event', handleBeforeInput);
    };
  }, [activeProfile]);

  // 窗口级 F11/F12 快捷键（webview 未获得焦点时生效，与顶栏按钮同一路径）
  // 注：Ctrl+W / ESC 由下方 useEscToCloseWindow 统一处理
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F11') {
        e.preventDefault();
        useTabStore.getState().toggleMaximize();
        return;
      }
      if (e.key === 'F12') {
        e.preventDefault();
        useTabStore.getState().toggleAlwaysOnTop();
        return;
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, []);

  // ESC / Ctrl+W 关窗：浮窗（设置面板/快捷键说明）由 useEscToCloseOverlay 统一处理；
  // onEsc 仅处理标题编辑态退出（非浮窗）；否则关闭窗口
  useEscToCloseWindow({
    onEsc: (e) => {
      // 标题编辑时退出编辑
      if (isEditingTitle) {
        e.preventDefault();
        setIsEditingTitle(false);
        return true;
      }
      return false;
    },
  });

  const startEditTitle = useCallback(() => {
    if (!activeTab) return;
    setTitleDraft(activeTab.title);
    setIsEditingTitle(true);
    requestAnimationFrame(() => titleInputRef.current?.select());
  }, [activeTab]);

  const commitTitle = useCallback(() => {
    if (!isEditingTitle || !activeTab) {
      setIsEditingTitle(false);
      return;
    }
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== activeTab.title) {
      void renameTab(activeTab.id, trimmed);
    }
    setIsEditingTitle(false);
  }, [isEditingTitle, activeTab, titleDraft, renameTab]);

  const handleMaximize = useCallback(async () => {
    try {
      const maximized = await maximizeToggleWindow();
      setMaximized(maximized);
    } catch (e) {
      console.error('最大化失败:', e);
    }
  }, [setMaximized]);

  return (
    <>
      <div className="standalone-view app-shell app-view-root" data-viewport={isNarrow ? 'narrow' : 'wide'} data-name="standalone.container">
        {/* ===== 顶栏（宽屏常驻；窄屏下隐藏导航/工具按钮，仅留标题 + 窗口控制） ===== */}
        <TitleBar
          maximized={isMaximized}
          onMinimize={() => void minimizeWindow()}
          onMaximize={() => void handleMaximize()}
          onClose={() => void closeCurrentWindow()}
          center={
            isEditingTitle ? (
              <span className="sa-top-title editing" data-name="standalone.top-bar.title-edit-wrapper">
                <input
                  ref={titleInputRef}
                  className="sa-top-title-input"
                  data-name="standalone.top-bar.title-input"
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
                      setIsEditingTitle(false);
                    }
                  }}
                />
              </span>
            ) : (
              <span
                className="sa-top-title"
                data-name="standalone.top-bar.title"
                title="双击重命名"
                onDoubleClick={startEditTitle}
              >
                {activeTitle}
              </span>
            )
          }
          actions={
            <>
              {/* 导航/工具按钮组（窄屏下隐藏） */}
              <div className="sa-nav-group" data-name="standalone.top-bar.nav-group">
                <IconButton
                  type="button"
                  className="sa-btn titlebar-icon-btn"
                  data-name="standalone.top-bar.back-icon-button"
                  aria-label="后退"
                  title="后退"
                  onClick={() => {
                    const wv = webviewRef.current;
                    if (wv && wv.canGoBack()) wv.goBack();
                  }}
                >
                  <svg className="icon-svg" data-name="standalone.top-bar.back-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                </IconButton>
                <IconButton
                  type="button"
                  className="sa-btn titlebar-icon-btn"
                  data-name="standalone.top-bar.forward-icon-button"
                  aria-label="前进"
                  title="前进"
                  onClick={() => {
                    const wv = webviewRef.current;
                    if (wv && wv.canGoForward()) wv.goForward();
                  }}
                >
                  <svg className="icon-svg" data-name="standalone.top-bar.forward-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </IconButton>
                <IconButton
                  type="button"
                  className="sa-btn titlebar-icon-btn"
                  data-name="standalone.top-bar.reload-icon-button"
                  aria-label="刷新"
                  title="刷新"
                  onClick={() => webviewRef.current?.reload()}
                >
                  <svg className="icon-svg" data-name="standalone.top-bar.reload-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="23 4 23 10 17 10" />
                    <polyline points="1 20 1 14 7 14" />
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                  </svg>
                </IconButton>
                <IconButton
                  type="button"
                  className="sa-btn titlebar-icon-btn"
                  data-name="standalone.top-bar.home-icon-button"
                  aria-label="主页"
                  title="回到默认页"
                  onClick={() => {
                    const wv = webviewRef.current;
                    if (wv) safeLoadURLWebview(wv, activeProfile?.aiPlatformUrl || '');
                  }}
                >
                  <svg className="icon-svg" data-name="standalone.top-bar.home-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                    <polyline points="9 22 9 12 15 12 15 22" />
                  </svg>
                </IconButton>
                <IconButton
                  type="button"
                  className="sa-btn titlebar-icon-btn"
                  data-name="standalone.top-bar.settings-icon-button"
                  aria-label="设置"
                  title="设置"
                  onClick={() => setIsSettingsOpen(true)}
                >
                  <svg className="icon-svg" data-name="standalone.top-bar.settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                </IconButton>
                <IconButton
                  type="button"
                  className="sa-btn titlebar-icon-btn"
                  data-name="standalone.top-bar.shortcuts-icon-button"
                  aria-label="快捷键"
                  title="快捷键"
                  onClick={() => setIsShortcutsOpen(true)}
                >
                  <svg className="icon-svg" data-name="standalone.top-bar.shortcuts-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="4" width="20" height="16" rx="2" />
                    <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10" />
                  </svg>
                </IconButton>
                <IconButton
                  type="button"
                  variant={alwaysOnTop ? 'active' : 'default'}
                  className="sa-btn titlebar-icon-btn"
                  data-name="standalone.top-bar.pin-icon-button"
                  aria-label="置顶"
                  title={alwaysOnTop ? '取消置顶' : '置顶'}
                  onClick={async () => {
                    const next = !alwaysOnTop;
                    setAlwaysOnTop(next);
                    try { await pinCurrentWindow(next); } catch (e) { setAlwaysOnTop(!next); }
                  }}
                >
                  <svg className="icon-svg" data-name="standalone.top-bar.pin-icon" viewBox="0 0 24 24" fill={alwaysOnTop ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="17" x2="12" y2="3" />
                    <path d="M6.5 8.5L12 3l5.5 5.5" />
                    <path d="M5 21h14" />
                  </svg>
                </IconButton>
              </div>
            </>
          }
        />

        {/* ===== 中央：webview ===== */}
        <div
          className="sa-webview-container"
          data-name="standalone.webview-container"
          style={{ display: 'flex' }}
        >
          {activeProfile && (activeTab?.url || activeProfile.aiPlatformUrl) && (
            <webview
              ref={webviewRef as React.RefObject<HTMLElement> as React.RefObject<WebviewElement>}
              data-name="standalone.webview-1"
              src={activeTab?.url || activeProfile.aiPlatformUrl}
              partition={`persist:${activeProfile.id}`}
              useragent={activeProfile.userAgent || undefined}
              allowpopups={true}
              style={{
                width: '100%',
                height: '100%',
                border: 'none',
                display: 'flex',
                position: 'absolute',
                inset: 0,
              }}
            />
          )}
        </div>

        {/* 自定义窗口边缘 resize（配合 thickFrame:false） */}
        <WindowResizeHandles />
      </div>
      <SettingsPanel open={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
      <ShortcutsModal
        open={isShortcutsOpen}
        onClose={() => setIsShortcutsOpen(false)}
        hotkeys={hotkeys}
      />
    </>
  );
}
