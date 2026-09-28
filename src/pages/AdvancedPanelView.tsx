/* =====================================================================
   pages/AdvancedPanelView.tsx —— 进阶面板主视图
   架构：
   - 顶栏：tab 切换（自定义供应商 / 自定义对话）+ 窗口控制（最小化/最大化/关闭）
   - 主体：根据 activeTab 渲染子页面
     · chat       —— 自定义对话（AdvancedPanelChatTab，复用 useChatStore）
     · whiteboard —— 白板（WhiteboardView）
     · notes      —— 灵感笔记（NotesView）
   - 通过 URL 查询参数 ?mode=advanced-panel[&provider=...&tab=...] 接收初始状态
   - 主进程通过 'advancedPanel:navigate' 事件通知切换 tab/provider（单例窗口复用时）
   ===================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WindowResizeHandles from '../components/WindowResizeHandles';
import { useChatStore } from '../store/useChatStore';
import { useModuleStore } from '../store/useModuleStore';
import {
  minimizeWindow,
  closeCurrentWindow,
  onAdvancedPanelNavigate,
  pinCurrentWindow,
  getAppSettings,
  onAppSettingsChanged,
} from '../lib/electron-api';
import { IconButton, SegmentedControl, TitleBar } from '../components/ui';
import { GearIcon } from '../components/icons';
import AdvancedPanelSettingsPanel from '../components/AdvancedPanelSettingsPanel';
import { ChatTab } from './AdvancedPanelChatTab';
import WhiteboardView from './WhiteboardView';
import NotesView from './NotesView';
import { useWindowMaximizedAndPinned } from '../hooks/useWindowMaximizedAndPinned';
import { useEscToCloseWindow } from '../hooks/useEscToCloseWindow';
import './ChatBubble.css';
import './AdvancedPanelView.css';

type TabKey = string;

/** 内置 tab 注册表（模块 ID → tab key + label） */
const BUILTIN_TAB_REGISTRY: Record<string, { key: string; label: string }> = {
  'custom-chat': { key: 'chat', label: '自定义对话' },
  whiteboard: { key: 'whiteboard', label: '白板' },
  notes: { key: 'notes', label: '灵感笔记' },
}

/** 从 URL 查询参数读取初始 tab */
function readInitialTab(): TabKey {
  if (typeof window === 'undefined') return 'chat';
  const t = new URLSearchParams(window.location.search).get('tab');
  return t ?? 'chat';
}

/** 从 URL 查询参数读取初始 providerId */
function readInitialProviderId(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('provider');
}

export default function AdvancedPanelView() {
  const [activeTab, setActiveTab] = useState<TabKey>(readInitialTab);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const beforeLeaveRef = useRef<((commit: () => void) => Promise<void>) | null>(null);
  const registerBeforeLeave = useCallback((guard: ((commit: () => void) => Promise<void>) | null) => {
    beforeLeaveRef.current = guard;
  }, []);
  const requestTab = useCallback((next: TabKey, after?: () => void) => {
    const commit = () => {
      activeTabRef.current = next;
      setActiveTab(next);
      after?.();
    };
    if (next !== activeTabRef.current && beforeLeaveRef.current) {
      void beforeLeaveRef.current(commit).catch((error) => console.error('[AdvancedPanel] leave failed:', error));
    } else {
      commit();
    }
  }, []);
  // 模块门控：自定义对话 / 白板 / 笔记模块关闭时隐藏对应 tab
  // 注意：不能用 (s) => s.isEnabled 作为 selector（函数引用恒定，zustand 不会触发重渲染）；
  // 改为订阅 modules 数组派生 enabled 集合，模块状态变化时组件必然重渲染。
  const modules = useModuleStore((s) => s.modules);
  const enabledModuleIds = useMemo(() => modules.filter((m) => m.enabled).map((m) => m.id), [modules]);
  const modulesInitialized = useModuleStore((s) => s.initialized);
  const moduleEnabled = (id: string) => enabledModuleIds.includes(id);

  // tab 注册表：合并内置 tab 和插件声明的 advancedPanelTab
  const tabRegistry = useMemo(() => {
    const reg: Record<string, { moduleId: string; label: string }> = {};
    // 内置 tab
    for (const [moduleId, tab] of Object.entries(BUILTIN_TAB_REGISTRY)) {
      reg[tab.key] = { moduleId, label: tab.label };
    }
    // 插件 tab（从 module info 的 advancedPanelTab 字段读取）
    for (const m of modules) {
      if (m.advancedPanelTab && !reg[m.advancedPanelTab.key]) {
        reg[m.advancedPanelTab.key] = { moduleId: m.id, label: m.advancedPanelTab.label };
      }
    }
    return reg;
  }, [modules]);

  const availableTabs = useMemo<TabKey[]>(() => {
    if (!modulesInitialized) return Object.keys(tabRegistry);
    return Object.entries(tabRegistry)
      .filter(([, entry]) => enabledModuleIds.includes(entry.moduleId))
      .map(([key]) => key);
  }, [tabRegistry, enabledModuleIds, modulesInitialized]);
  const { isMaximized, isPinned, setIsMaximized, setIsPinned, handleMaximize } = useWindowMaximizedAndPinned();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const initialProviderId = useMemo(() => readInitialProviderId(), []);

  // 白板应用层侧边栏显隐（默认 false；Excalidraw 无内置多页面 UI，sidebar 是多白板管理入口）
  // 设置面板关闭时重新读取，使设置变更立即生效
  const [whiteboardSidebarVisible, setWhiteboardSidebarVisible] = useState(false);
  useEffect(() => {
    void getAppSettings()
      .then((cfg) => setWhiteboardSidebarVisible(cfg.whiteboardSidebarVisible ?? false))
      .catch(() => {});
  }, []);

  // 监听主进程的 navigate 事件（单例窗口复用时切换 tab/provider）
  useEffect(() => {
    return onAdvancedPanelNavigate((payload) => {
      requestTab(payload.tab, () => {
        if (payload.providerId) useChatStore.getState().setCurrentProvider(payload.providerId);
      });
    });
  }, [requestTab]);

  // Ctrl+1/2/3、Alt+1/2/3、Ctrl+Tab、Ctrl+Shift+Tab 切换进阶面板标签
  // 输入框内也生效（可通过设置关闭，立即生效）
  // 注意：切换范围只含已启用模块的 tab（availableTabs），避免切到已关闭模块导致空白
  const tabOrder: TabKey[] = availableTabs;
  const tabSwitchRef = useRef(true);
  useEffect(() => {
    void getAppSettings().then((cfg) => { tabSwitchRef.current = cfg.advancedPanelTabSwitchShortcuts !== false; }).catch(() => {});
    const off = onAppSettingsChanged((cfg) => {
      tabSwitchRef.current = cfg.advancedPanelTabSwitchShortcuts !== false;
    });
    return off;
  }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!tabSwitchRef.current) return;
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const idx = Number(e.key) - 1;
        const next = availableTabs[idx];
        if (next) { e.preventDefault(); requestTab(next); }
        return;
      }
      if (!e.ctrlKey || e.altKey || e.metaKey) return;

      if (e.key === 'Tab') {
        e.preventDefault();
        const currentIndex = tabOrder.indexOf(activeTab);
        const nextIndex = e.shiftKey
          ? (currentIndex - 1 + tabOrder.length) % tabOrder.length
          : (currentIndex + 1) % tabOrder.length;
        if (tabOrder[nextIndex]) requestTab(tabOrder[nextIndex]);
        return;
      }

      if (e.shiftKey) return;
      const idx = Number(e.key) - 1;
      const next = availableTabs[idx];
      if (next) { e.preventDefault(); requestTab(next); }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [activeTab, availableTabs, requestTab]);

  // 初始化时若 URL 指定了 provider，切换 chat tab 并选中该 provider
  useEffect(() => {
    if (initialProviderId) {
      requestTab('chat', () => useChatStore.getState().setCurrentProvider(initialProviderId));
    }
  }, [initialProviderId, requestTab]);

  // 模块联动：当前 tab 被关闭时自动切到第一个可用 tab（避免内容区空白）
  useEffect(() => {
    if (modulesInitialized && !availableTabs.includes(activeTab)) {
      requestTab(availableTabs[0] ?? '');
    }
  }, [availableTabs, activeTab, modulesInitialized, requestTab]);

  const handleClose = useCallback(() => {
    const close = () => { void closeCurrentWindow().catch(() => {}); };
    if (beforeLeaveRef.current) {
      void beforeLeaveRef.current(close).catch((error) => console.error('[AdvancedPanel] close failed:', error));
    } else close();
  }, []);
  useEscToCloseWindow({ ctrlW: false, onEsc: (event) => { event.preventDefault(); handleClose(); return true; } });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'w') {
        event.preventDefault();
        handleClose();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [handleClose]);

  const handleMinimize = useCallback(() => void minimizeWindow().catch(() => {}), []);
  // handleMaximize 由 useWindowMaximizedAndPinned 统一提供

  return (
    <div className="advanced-panel-provider-view app-shell app-view-root" data-name="advanced-panel.container">
      <TitleBar
        maximized={isMaximized}
        onMinimize={handleMinimize}
        onMaximize={handleMaximize}
        onClose={handleClose}
        center={
          <SegmentedControl<TabKey>
            value={activeTab}
            onChange={requestTab}
            name="advanced-panel-tab"
            className="advanced-panel-segmented"
            options={availableTabs.map((t) => ({
              value: t,
              label: tabRegistry[t]?.label ?? t,
            }))}
          />
        }
        actions={
          <>
            <IconButton
              type="button"
              onClick={() => setSettingsOpen(true)}
              title="设置"
              aria-label="设置"
              data-name="advanced-panel.topbar-settings-button"
            >
              <GearIcon className="icon-svg" />
            </IconButton>
            <IconButton
              type="button"
              variant={isPinned ? 'active' : 'default'}
              onClick={async () => {
                const next = !isPinned;
                setIsPinned(next);
                try { await pinCurrentWindow(next); } catch { setIsPinned(!next); }
              }}
              title={isPinned ? '取消置顶' : '置顶'}
              aria-label={isPinned ? '取消置顶' : '置顶'}
              data-name="advanced-panel.topbar-pin-button"
            >
              <svg viewBox="0 0 24 24" fill={isPinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '60%', height: '60%' }} data-name="advanced-panel.topbar-pin-icon">
                <path d="M12 17v5" />
                <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
              </svg>
            </IconButton>
          </>
        }
      />
      <div className="advanced-panel-provider-body" data-name="advanced-panel.body">
        {activeTab === 'chat' && moduleEnabled('custom-chat') && (
          <ChatTab onOpenSettings={() => setSettingsOpen(true)} />
        )}
        {activeTab === 'whiteboard' && (
          <WhiteboardView
            onBeforeLeaveReady={registerBeforeLeave}
            onClose={() => requestTab(availableTabs[0] ?? 'chat')}
            sidebarVisible={whiteboardSidebarVisible}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        )}
        {activeTab === 'notes' && (
          <NotesView onOpenSettings={() => setSettingsOpen(true)} onBeforeLeaveReady={registerBeforeLeave} />
        )}
        {/* 插件 tab 渲染：非内置 tab 时显示插件提供的 UI 或占位 */}
        {!['chat', 'whiteboard', 'notes'].includes(activeTab) && tabRegistry[activeTab] && (
          <div className="advanced-panel-plugin-tab" data-name={'advanced-panel.plugin.' + activeTab}>
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--foreground-muted)' }}>
              {tabRegistry[activeTab].label}
            </div>
          </div>
        )}
        {availableTabs.length === 0 && <div style={{ height: '100%' }} data-name="advanced-panel.empty" />}
      </div>
      <AdvancedPanelSettingsPanel
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
          // 设置面板关闭时重新读取白板侧边栏设置，使开关变化立即生效
          void getAppSettings()
            .then((cfg) => setWhiteboardSidebarVisible(cfg.whiteboardSidebarVisible ?? false))
            .catch(() => {});
        }}
      />
      <WindowResizeHandles />
    </div>
  );
}
