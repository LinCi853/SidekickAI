/* =====================================================================
   App.tsx —— 应用根组件（路由分流）
   主进程通过 URL 查询参数 ?windowId=<id> 标识当前窗口：
   - windowId === 'main' → MainView（多标签 + 顶栏 + 底栏）
   - 其他（UUID）       → StandaloneView（脱离窗口单标签）
   挂载时按顺序初始化所有 stores（TabStore → ProfileStore → WindowStore），
   全部完成后才渲染实际视图，保证状态就绪。
   ===================================================================== */

import { Component, useEffect, useState, type ReactNode } from 'react';
import MainView from './pages/MainView';
import StandaloneView from './pages/StandaloneView';
import ChatView from './pages/ChatView';
import RecordIndicator from './pages/RecordIndicator';
import HistoryView from './pages/HistoryView';
import PromptLibraryView from './pages/PromptLibraryView';
import AiAppEditor from './pages/AiAppEditor';
import AdvancedPanelView from './pages/AdvancedPanelView';
import DataExportWindow from './pages/DataExportWindow';
import OnboardingView from './pages/OnboardingView';
import SettingsView from './pages/SettingsView';
import BrowserView from './pages/BrowserView';
import Button from './components/ui/Button';
import { useProfileStore } from './store/useProfileStore';
import { useTabStore } from './store/useTabStore';
import { useWindowStore } from './store/useWindowStore';
import { usePromptStore } from './store/usePromptStore';
import { getAppSettings, onUiScaleChanged, onAppSettingsChanged, onUiVersionChanged, setMinimumSize } from './lib/electron-api';
import {
  calculateMainWindowMinWidth,
  calculateChatWindowMinWidth,
  calculateAdvancedPanelMinWidth,
  MAIN_WINDOW_MIN_HEIGHT,
  CHAT_WINDOW_MIN_HEIGHT,
  ADVANCED_PANEL_MIN_HEIGHT,
  calculateOxyMainWindowMinWidth,
  calculateOxyMainWindowMinWidthByScale,
  calculateOxyChatWindowMinWidthByScale,
  calculateOxyAdvancedPanelMinWidthByScale,
  type UiScale,
  type OxyScale,
} from '../electron/shared/window-size';
import { useUiVersionStore } from './store/useUiVersionStore';
import { useThemeStore } from './store/useThemeStore';
import { getOxyLayout, activateOxy, deactivateOxy } from './lib/oxy-design-system';

/* =====================================================================
   ErrorBoundary —— 捕获子组件渲染错误，防止单个 webview 报错导致整个应用白屏
   ===================================================================== */
interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}
class AppErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, info: { componentStack: string }): void {
    console.error('[ErrorBoundary] 捕获渲染错误:', error, info.componentStack);
  }
  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div data-name="app.error-boundary.container" style={{ padding: 'var(--space-6)', textAlign: 'center', fontFamily: 'system-ui, sans-serif' }}>
          <h3 data-name="app.error-boundary.title" style={{ marginBottom: 'var(--space-2)' }}>页面渲染出错</h3>
          <p data-name="app.error-boundary.message" style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-base)', marginBottom: 'var(--space-4)', wordBreak: 'break-word' }}>
            {this.state.error?.message || '未知错误'}
          </p>
          <Button
            data-name="app.error-boundary.retry-button"
            variant="ghost"
            onClick={() => this.setState({ hasError: false, error: undefined })}
          >
            重试
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

/** 从 URL 查询参数获取当前窗口 id（默认 'main'） */
function getWindowId(): string {
  if (typeof window === 'undefined') return 'main';
  return new URLSearchParams(window.location.search).get('windowId') ?? 'main';
}

/** 从 URL 查询参数获取窗口模式（'chat' 表示自定义对话脱离窗口） */
function getWindowMode(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('mode');
}

/** 暖砖红骨架屏 */
function LoadingScreen() {
  return (
    <div
      data-name="app.loading-screen.container"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        background: 'var(--background)',
      }}
    >
      <div
        data-name="app.loading-screen.card"
        style={{
          padding: 'var(--space-8) var(--space-12)',
          textAlign: 'center',
          background: 'var(--glass-bg)',
          border: '1px solid var(--glass-bd)',
          borderRadius: 'var(--radius-lg)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
        }}
      >
        <div
          data-name="app.loading-screen.logo"
          style={{
            width: 'var(--titlebar-icon)',
            height: 'var(--titlebar-icon)',
            margin: '0 auto var(--space-3)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'linear-gradient(135deg, var(--accent), var(--accent-dim))',
            borderRadius: 'var(--radius-md)',
            color: 'var(--accent-bright-foreground)',
            fontFamily: 'var(--font-sans)',
            fontWeight: 800,
            fontSize: 'var(--text-md)',
            boxShadow: '0 0 16px var(--accent-50)',
          }}
        >
          W
        </div>
        <div
          data-name="app.loading-screen.title"
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--text-xl)',
            fontWeight: 700,
            letterSpacing: '0.04em',
            color: 'var(--accent-bright)',
          }}
        >
          工百窗
        </div>
        <div
          data-name="app.loading-screen.subtitle"
          style={{
            marginTop: 'var(--space-2)',
            color: 'var(--muted-foreground)',
            fontSize: 'var(--text-sm)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          正在初始化...
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);

  // 从 URL 获取当前窗口 id 与模式
  const windowId = getWindowId();
  const mode = getWindowMode();
  const isMain = windowId === 'main';
  // 旧单例 chat 窗口（windowId='chat'）或新 chat 脱离窗口（mode='chat'）
  const isChat = windowId === 'chat' || mode === 'chat';
  // 录音指示器（windowId='preview' + mode='record-indicator'，默认无 mode 时也走它）
  const isRecordIndicator = windowId === 'preview' && (mode === null || mode === 'record-indicator');
  const isHistory = mode === 'history';
  const isPrompts = mode === 'prompts';
  const isAiAppEditor = mode === 'ai-app-editor';
  const isAdvancedPanel = mode === 'advanced-panel';
  const isOnboarding = mode === 'onboarding';
  const isDataExport = mode === 'data-export';
  const isSettings = mode === 'settings';
  const isBrowser = mode === 'browser';

  // chat/preview/history/prompts/ai-app-editor/advanced-panel/onboarding/data-export 窗口无需初始化 TabStore/ProfileStore，直接渲染
  // 设置窗口需要加载 ProfileStore（AI 应用卡片依赖），但不需 TabStore
  useEffect(() => {
    if (isChat || isRecordIndicator || isHistory || isPrompts || isAiAppEditor || isAdvancedPanel || isOnboarding || isDataExport || isSettings || isBrowser) {
      setReady(true);
      // 即使是辅助窗口也应用 UI 比例（Oxy 模式下跳过，避免 scale.css 覆盖 JS 注入变量）
      void getAppSettings().then((cfg) => {
        const isOxy = useUiVersionStore.getState().version === 'oxy';
        if (!isOxy) {
          document.documentElement.setAttribute('data-ui-scale', cfg.uiScale ?? 'medium');
        }
      }).catch(() => {});
      // 设置窗口需要加载 Profile 列表（AI 应用卡片依赖 useProfileStore）
      if (isSettings) {
        void useProfileStore.getState().loadProfiles().catch((e) => {
          console.error('[App] 设置窗口加载 Profile 列表失败:', e);
        });
      }
      return;
    }
    let cancelled = false;

    (async () => {
      // 1. 初始化 TabStore（加载窗口持久化状态 + 初始化 UI 默认值）
      //    这必须在加载 Profile 之前，因为 addTab 需要 profiles 就绪
      console.log('[App] 1. 开始初始化 TabStore, windowId:', windowId);
      try {
        await useTabStore.getState().init(windowId);
        console.log('[App] 1. TabStore 初始化完成');
      } catch (e) {
        console.error('[App] 1. TabStore 初始化失败:', e);
      }

      // 2. 初始化 WindowStore（UI 默认值）
      console.log('[App] 2. 初始化 WindowStore');
      useWindowStore.getState().init();

      // 3. 加载 Profile 列表（ensureDefaultProfiles 已在主进程完成）
      console.log('[App] 3. 开始加载 Profile 列表');
      try {
        await useProfileStore.getState().loadProfiles();
        const profileCount = useProfileStore.getState().profiles.length;
        console.log('[App] 3. Profile 列表加载完成，数量:', profileCount);
      } catch (e) {
        console.error('[App] 3. 加载 Profile 列表失败:', e);
      }

      // 4. 加载提示词模板（明输入明注入）
      console.log('[App] 4. 开始加载提示词模板');
      try {
        await usePromptStore.getState().init();
        console.log('[App] 4. 提示词模板加载完成');
      } catch (e) {
        console.error('[App] 4. 提示词模板加载失败:', e);
      }

      // 打印当前 TabStore 状态
      const ts = useTabStore.getState();
      const ps = useProfileStore.getState();
      console.log('[App] 最终状态: initialized=', ts.initialized, 'tabs=', ts.tabs.length, 'profiles=', ps.profiles.length);

      if (!cancelled) {
        console.log('[App] 渲染视图');
        // 应用 UI 比例设置（Oxy 模式下不设置 data-ui-scale，避免 scale.css 静态值覆盖 JS 注入的变量）
        try {
          const isOxy = useUiVersionStore.getState().version === 'oxy';
          if (!isOxy) {
            const cfg = await getAppSettings();
            document.documentElement.setAttribute('data-ui-scale', cfg.uiScale ?? 'medium');
          }
        } catch { /* ignore */ }
        setReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [windowId, isChat, isRecordIndicator, isHistory, isPrompts, isAiAppEditor, isAdvancedPanel, isOnboarding, isDataExport, isSettings, isBrowser]);

  // 监听 UI 比例变化广播：更新 data-ui-scale 属性 + 重新计算当前窗口最小尺寸。
  // 主进程在 uiScale 变更后向所有窗口推送；各窗口根据自身类型选用对应公式。
  useEffect(() => {
    const off = onUiScaleChanged(async (uiScale: UiScale) => {
      // Oxy 模式下不更新 data-ui-scale，避免 scale.css 静态值覆盖 JS 注入变量
      const isOxy = useUiVersionStore.getState().version === 'oxy';
      if (!isOxy) {
        document.documentElement.setAttribute('data-ui-scale', uiScale);
      }
      // Oxy 模式下使用 V2 连续 scale 计算
      const oxyLayout = getOxyLayout();
      const oxyScale = oxyLayout?.scale ?? 1.0;
      // 根据当前窗口类型选择对应的最小尺寸计算公式
      let minWidth: number | null = null;
      let minHeight: number | null = null;
      if (isMain) {
        try {
          const cfg = await getAppSettings();
          const tabState = useTabStore.getState();
          const activeTab = tabState.tabs.find((t) => t.id === tabState.activeTabId);
          const title = activeTab?.title;
          if (isOxy && oxyLayout) {
            minWidth = calculateOxyMainWindowMinWidthByScale(oxyScale, cfg.topBarVisibleButtons, title);
          } else {
            minWidth = calculateMainWindowMinWidth(uiScale, cfg.topBarVisibleButtons, title);
          }
        } catch {
          if (isOxy && oxyLayout) {
            minWidth = calculateOxyMainWindowMinWidthByScale(oxyScale);
          } else {
            minWidth = calculateMainWindowMinWidth(uiScale);
          }
        }
        minHeight = MAIN_WINDOW_MIN_HEIGHT;
      } else if (isChat) {
        if (isOxy && oxyLayout) {
          minWidth = calculateOxyChatWindowMinWidthByScale(oxyScale);
        } else {
          minWidth = calculateChatWindowMinWidth(uiScale);
        }
        minHeight = CHAT_WINDOW_MIN_HEIGHT;
      } else if (mode === 'advanced-panel') {
        if (isOxy && oxyLayout) {
          minWidth = calculateOxyAdvancedPanelMinWidthByScale(oxyScale);
        } else {
          minWidth = calculateAdvancedPanelMinWidth(uiScale);
        }
        minHeight = ADVANCED_PANEL_MIN_HEIGHT;
      }
      if (minWidth != null && minHeight != null) {
        void setMinimumSize(minWidth, minHeight).catch((e) =>
          console.warn('[App] setMinimumSize 失败:', e),
        );
      }
    });
    return off;
  }, [isMain, isChat, mode]);

  // 监听应用设置变更广播：任意窗口修改设置后，主进程向所有窗口推送最新设置。
  // 更新 data-ui-scale + 重新计算窗口最小尺寸（与 onUiScaleChanged 逻辑一致，
  // 但覆盖所有设置变更场景，不仅限于 uiScale）。
  useEffect(() => {
    const off = onAppSettingsChanged(async (cfg) => {
      const isOxy = useUiVersionStore.getState().version === 'oxy';
      if (!isOxy) {
        document.documentElement.setAttribute('data-ui-scale', cfg.uiScale ?? 'medium');
      }
      // 重新计算窗口最小尺寸
      const oxyLayout = getOxyLayout();
      const oxyScale = oxyLayout?.scale ?? 1.0;
      const uiScale = (cfg.uiScale ?? 'medium') as UiScale;
      let minWidth: number | null = null;
      let minHeight: number | null = null;
      if (isMain) {
        try {
          const tabState = useTabStore.getState();
          const activeTab = tabState.tabs.find((t) => t.id === tabState.activeTabId);
          const title = activeTab?.title;
          if (isOxy && oxyLayout) {
            minWidth = calculateOxyMainWindowMinWidthByScale(oxyScale, cfg.topBarVisibleButtons, title);
          } else {
            minWidth = calculateMainWindowMinWidth(uiScale, cfg.topBarVisibleButtons, title);
          }
        } catch {
          if (isOxy && oxyLayout) {
            minWidth = calculateOxyMainWindowMinWidthByScale(oxyScale);
          } else {
            minWidth = calculateMainWindowMinWidth(uiScale);
          }
        }
        minHeight = MAIN_WINDOW_MIN_HEIGHT;
      } else if (isChat) {
        if (isOxy && oxyLayout) {
          minWidth = calculateOxyChatWindowMinWidthByScale(oxyScale);
        } else {
          minWidth = calculateChatWindowMinWidth(uiScale);
        }
        minHeight = CHAT_WINDOW_MIN_HEIGHT;
      } else if (mode === 'advanced-panel') {
        if (isOxy && oxyLayout) {
          minWidth = calculateOxyAdvancedPanelMinWidthByScale(oxyScale);
        } else {
          minWidth = calculateAdvancedPanelMinWidth(uiScale);
        }
        minHeight = ADVANCED_PANEL_MIN_HEIGHT;
      }
      if (minWidth != null && minHeight != null) {
        void setMinimumSize(minWidth, minHeight).catch((e) =>
          console.warn('[App] setMinimumSize 失败:', e),
        );
      }
    });
    return off;
  }, [isMain, isChat, mode]);

  // 监听 UI 版本/主题变更广播：任意窗口切换 Oxy Design System 或主题模式后实时同步。
  // UI 版本直接调用 activateOxy/deactivateOxy；主题通过 setTheme 应用。
  // setTheme 内部也会广播，但接收端 curTheme 已更新所以不会产生循环。
  useEffect(() => {
    const off = onUiVersionChanged(({ uiVersion, theme }) => {
      // 同步 UI 版本（Oxy / 经典版）——直接调用控制器，不经过 setVersion 避免循环广播
      const curVersion = useUiVersionStore.getState().version;
      if (uiVersion !== curVersion) {
        if (uiVersion === 'oxy') {
          activateOxy();
        } else {
          deactivateOxy();
        }
        useUiVersionStore.setState({ version: uiVersion });
      }
      // 同步主题模式
      const curTheme = useThemeStore.getState().theme;
      if (theme !== curTheme) {
        useThemeStore.getState().setTheme(theme);
      }
    });
    return off;
  }, []);

  if (!ready) {
    return <LoadingScreen />;
  }

  // 路由分流：preview(默认/record-indicator) → RecordIndicator,
  //   history → HistoryView, prompts → PromptLibraryView,
  //   ai-app-editor → AiAppEditor, advanced-panel → AdvancedPanelView,
  //   notes → NotesView, whiteboard → WhiteboardView,
  //   chat → ChatView, 主窗口 → MainView, 脱离窗口 → StandaloneView
  // 所有视图用 ErrorBoundary 包裹，防止单个 webview 报错导致整个应用白屏
  if (isRecordIndicator) return <AppErrorBoundary><RecordIndicator /></AppErrorBoundary>;
  if (isHistory) return <AppErrorBoundary><HistoryView /></AppErrorBoundary>;
  if (isPrompts) return <AppErrorBoundary><PromptLibraryView /></AppErrorBoundary>;
  if (isAiAppEditor) return <AppErrorBoundary><AiAppEditor /></AppErrorBoundary>;
  if (isAdvancedPanel) return <AppErrorBoundary><AdvancedPanelView /></AppErrorBoundary>;
  if (isDataExport) return <AppErrorBoundary><DataExportWindow /></AppErrorBoundary>;
  if (isSettings) return <AppErrorBoundary><SettingsView /></AppErrorBoundary>;
  if (isOnboarding) return <AppErrorBoundary><OnboardingView /></AppErrorBoundary>;
  if (isChat) return <AppErrorBoundary><ChatView windowId={mode === 'chat' ? windowId : undefined} /></AppErrorBoundary>;
  if (isBrowser) return <AppErrorBoundary><BrowserView /></AppErrorBoundary>;
  return <AppErrorBoundary>{isMain ? <MainView /> : <StandaloneView />}</AppErrorBoundary>;
}
