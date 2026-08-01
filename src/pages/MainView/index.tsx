/* =====================================================================
   pages/MainView.tsx —— 主窗口视图（多标签 + 顶栏 + 底栏）
   架构：
   - 中央：多 <webview> 并存，仅激活标签可见（切换不重建，保留状态）
   - 顶栏（宽屏常驻；窄屏隐藏，控制按钮移到底栏）：AppSwitcher 图标 → 可编辑标题 → 最小化/最大化/关闭/置顶
   - 底栏（auto-hide，可展开可拖拽调高）：
       · 折叠行：当前标签列表 + 展开按钮
       · 展开面板：标签列表（关闭/脱离）+ 应用快捷切换 + 设置 + 快捷键 + 指纹
   - 默认首次打开 DeepSeek（而非本应用设置）
   - 所有状态通过 useTabStore 持久化（bounds / tabs / activeTabId / alwaysOnTop / bottomBarExpanded / bottomBarHeight）
   ===================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { openSettingsWindow } from '../../lib/electron-api';
import ShortcutsModal from '../../components/ShortcutsModal';
import DrawerPanel from '../../components/DrawerPanel';
import WindowResizeHandles from '../../components/WindowResizeHandles';
import { useHotkeys } from '../../hooks/useHotkeys';
import { injectTextToWebview, triggerSendInWebview, injectEnterSendBehavior, focusInputInWebview, type WebviewLike } from '../../hooks/useWebViewControl';
import { useProfileStore } from '../../store/useProfileStore';
import { useTabStore } from '../../store/useTabStore';
import {
  maximizeToggleWindow,
  isWindowMaximized,
  listAIPlatforms,
  getPresetAIPlatforms,
  getWindowBounds,
  onVoiceInjectAndSend,
  onChatRequestConfig,
  openHistoryWindow,
  openPromptWindow,
  onPromptInjectRequest,
  sendPromptInjectResult,
  getAppSettings,
  getLastConversationUrl,
  onWindowShown,
  onWindowHidden,
  onWebviewHotkey,
  getHotkeys,
  setMinimumSize,
  ALL_TOP_BAR_BUTTON_GROUPS,
} from '../../lib/electron-api';
import {
  calculateMainWindowMinWidth,
  calculateOxyMainWindowMinWidthByScale,
  MAIN_WINDOW_MIN_HEIGHT,
  type UiScale,
} from '../../../electron/shared/window-size';
import type { Profile, AIPlatform, HotkeyConfig, TopBarButtonGroup, PromptTemplate } from '../../lib/electron-api';
import { type WebviewElement, safeReloadWebview, safeLoadURLWebview } from '../../lib/webview';
import { composeFinalText } from '../../lib/prompt-placeholders';
import { useThemeStore } from '../../store/useThemeStore';
import { useUiVersionStore } from '../../store/useUiVersionStore';
import { applyAppTheme, getOxyLayout } from '../../lib/oxy-design-system';
import { getPlatformColors } from './utils';
import './styles.css';
import { WebviewTab } from './WebviewTab';
import TabContextMenu from './TabContextMenu';
import BottomBar from './BottomBar';
import TopBar from './TopBar';
import TabBar from './TabBar';
import { useTabContextMenu } from './useTabContextMenu';
import { useMainViewKeyboard } from './useMainViewKeyboard';
import { useShortcutsToggle } from '../../hooks/useShortcutsToggle';
import { useToast } from '../../hooks/useToast';
import { usePromptHotkeys } from '../../hooks/usePromptHotkeys';
import FileDropOverlay from './FileDropOverlay';
import { buildFileDropScript, type DroppedFileInfo } from './file-drop-script';
import {
  dropFiles,
  onDownloadDone,
  findSimilarInjection,
  logInjection,
  type SimilarInjectionResult,
} from '../../lib/electron-api';
import InjectionPreviewModal from '../../components/InjectionPreviewModal';

export default function MainView() {
  // 从 TabStore 读取当前窗口状态（初始化已在 App.tsx 完成）
  const {
    tabs,
    activeTabId,
    isMaximized,
    alwaysOnTop,
    bottomBarExpanded,
    bottomBarHeight,
    initialized,
    addTab,
    closeTab,
    setActiveTab,
    renameTab,
    updateTabUrl,
    updateTabHomeUrl,
    moveTab,
    detachTab,
    setAlwaysOnTop,
    setMaximized,
    toggleBottomBar,
    setBottomBarHeight,
  } = useTabStore();

  // 从 ProfileStore 读取 Profile 列表（已在 App.tsx 加载）
  const profiles = useProfileStore((s) => s.profiles);
  const updateProfile = useProfileStore((s) => s.updateProfile);
  const updateProfileUaLockMode = useProfileStore((s) => s.updateProfileUaLockMode);

  // settingsOpen 已移除：设置改为独立窗口，主窗口无需跟踪设置面板状态
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // ShortcutsModal 动态渲染全局热键（自定义 accelerator + 启用状态）
  const [hotkeys, setHotkeys] = useState<HotkeyConfig[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isBottomHovered, setIsBottomHovered] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  // 长宽自适应：< 600px 视为窄屏（紧凑模式），仅用于 App UI 切换
  // 网页 UA 保持移动端（与 Alt+Q 一致），避免宽屏下网页出现右侧阴影/渐变
  const [isNarrow, setIsNarrow] = useState(
    typeof window !== 'undefined' ? window.innerWidth < 600 : false,
  );
  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < 600);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const [titleDraft, setTitleDraft] = useState('');
  const [allPlatforms, setAllPlatforms] = useState<AIPlatform[]>([]);
  // 关键修复：平台列表是本地预置配置，应同步直出、立即渲染。
  // 用 getPresetAIPlatforms() 同步获取预置列表作为初值，UI 立即显示，无 loading 状态。
  const [platforms, setPlatforms] = useState<AIPlatform[]>(getPresetAIPlatforms());
  const [hiddenPlatforms, setHiddenPlatforms] = useState<string[]>([]);
  // 是否自动屏蔽国外模型（region === 'global'）。默认 true 与 store 默认值一致。
  const [hideForeignModels, setHideForeignModels] = useState(true);
  const [isTabBarCollapsed, setIsTabBarCollapsed] = useState(true);
  const [enterToSend, setEnterToSend] = useState(true);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  // 点击已打开应用时的行为：switch=跳转(默认) / close=关闭。BottomBar 据此决定是否显示二次确认关闭提示
  const [appClickBehavior, setAppClickBehavior] = useState<'switch' | 'close'>('switch');
  // 顶栏可见按钮组（从 app-settings 读取，未列出的按钮组隐藏；最小化/最大化/关闭始终显示）
  const [topBarVisibleButtons, setTopBarVisibleButtons] = useState<TopBarButtonGroup[]>([...ALL_TOP_BAR_BUTTON_GROUPS]);
  // 文件拖拽导入：dragenter/dragleave 用计数器准确判定窗口进出
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  // platforms 的 ref 镜像：供 onDrop 闭包内读取最新值，避免闭包过期（不加入 useEffect 依赖避免频繁重挂监听）
  const platformsRef = useRef<AIPlatform[]>(platforms);
  useEffect(() => { platformsRef.current = platforms; }, [platforms]);
  // 下载完成 / 拖拽导入反馈 toast（3000ms 自动消失）
  const { toast: downloadToast, showToast: showDownloadToast } = useToast(3000);

  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const draggingTabRef = useRef<string | null>(null);

  // 窗口内快捷键
  useHotkeys({});

  // 窗口重新显示/聚焦到前台时（启动/快捷键唤出/第二实例唤醒）聚焦激活的 webview 输入框
  // 使用主进程 WINDOW_SHOWN IPC 代替 window.focus 事件（后者在 hide/show 循环后不稳定）
  useEffect(() => {
    const focusActiveInput = () => {
      const activeTabId = useTabStore.getState().activeTabId;
      if (!activeTabId) return;
      const el = document.querySelector(`webview[data-tab-id="${activeTabId}"]`) as WebviewLike | null;
      if (el) {
        el?.focus?.();
        // 聚焦页面内的对话输入框
        focusInputInWebview(el, null).catch((e) => console.warn('[main-view] 操作失败:', e));
      }
    };
    // IPC 通道：主进程 show/focus 后通知
    const offShown = onWindowShown(focusActiveInput);
    // 兜底：window focus 事件（直接点击窗口时触发）
    window.addEventListener('focus', focusActiveInput);
    return () => {
      offShown();
      window.removeEventListener('focus', focusActiveInput);
    };
  }, []);

  // 窗口隐藏时自动收起所有展开的面板，防止用户下次打开时面板仍残留
  useEffect(() => {
    const offHidden = onWindowHidden(() => {
      useTabStore.getState().setBottomBarExpanded(false);
      setDrawerOpen(false);
      setShortcutsOpen(false);
    });
    return () => { offHidden(); };
  }, []);

  // 文件拖拽导入：监听 OS 级文件拖入，注入到当前激活 webview
  // document 级监听 + 计数器：dragenter/dragleave 在子元素间会多次触发，用计数器判定真正进出窗口
  useEffect(() => {
    const hasFiles = (e: DragEvent) =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragCounterRef.current += 1;
      setIsDragOver(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // 必须 preventDefault 才能触发后续 drop
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragCounterRef.current -= 1;
      if (dragCounterRef.current <= 0) {
        dragCounterRef.current = 0;
        setIsDragOver(false);
      }
    };
    const onDrop = async (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDragOver(false);
      if (!e.dataTransfer) return;
      // Electron 特性：File.path 暴露真实文件系统路径（sandbox:false 下可用）
      const paths = Array.from(e.dataTransfer.files)
        .map((f) => (f as File & { path?: string }).path)
        .filter((p): p is string => !!p);
      if (paths.length === 0) {
        showDownloadToast('未能获取文件路径');
        return;
      }
      const activeTabIdNow = useTabStore.getState().activeTabId;
      if (!activeTabIdNow) {
        showDownloadToast('没有激活的标签');
        return;
      }
      const wv = document.querySelector(
        `webview[data-tab-id="${activeTabIdNow}"]`,
      ) as WebviewElement | null;
      if (!wv) {
        showDownloadToast('未找到当前标签');
        return;
      }
      try {
        const fileInfos: DroppedFileInfo[] = await dropFiles(paths);
        if (fileInfos.length === 0) {
          showDownloadToast('读取文件失败');
          return;
        }
        // 从当前激活 tab 的 platform 配置取文件上传选择器（智谱等平台自定义）
        const activeTabNow = useTabStore.getState().tabs.find((t) => t.id === activeTabIdNow);
        const profileNow = activeTabNow
          ? useProfileStore.getState().profiles.find((p) => p.id === activeTabNow.profileId)
          : null;
        const platformNow = profileNow
          ? platformsRef.current.find((p) => p.id === profileNow.aiPlatformId || p.url === profileNow.aiPlatformUrl)
          : null;
        const dropOptions = platformNow
          ? { fileInputSelector: platformNow.fileInputSelector, dropZoneSelector: platformNow.dropZoneSelector }
          : undefined;
        const script = buildFileDropScript(fileInfos, dropOptions);
        await wv.executeJavaScript(script);
        showDownloadToast(`已导入 ${fileInfos.length} 个文件到当前应用`);
      } catch (err) {
        console.error('[MainView] 文件拖拽导入失败:', err);
        showDownloadToast('导入失败');
      }
    };

    document.addEventListener('dragenter', onDragEnter);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('drop', onDrop);
    };
  }, [showDownloadToast]);

  // 下载完成通知：主进程广播 APP_DOWNLOAD_DONE 时显示 toast
  useEffect(() => {
    const off = onDownloadDone(({ filename }) => {
      showDownloadToast(`下载完成：${filename}`);
    });
    return () => off();
  }, [showDownloadToast]);

  // ShortcutsModal 打开时加载最新全局热键配置（自定义 accelerator + 启用状态）
  useEffect(() => {
    if (!shortcutsOpen) return;
    getHotkeys()
      .then((list) => setHotkeys(list))
      .catch((e) => console.error('加载全局热键失败（ShortcutsModal）:', e));
  }, [shortcutsOpen]);

  // 键盘快捷键：Ctrl+Tab 切换 / F12 置顶 / Alt+1~9 / 长按 Tab 调出底栏
  useMainViewKeyboard(bottomBarExpanded, toggleBottomBar);

  // 主题状态（供顶栏主题切换按钮显示当前 light/dark 图标）
  const isDarkTheme = useThemeStore((s) => s.resolved === 'dark');

  // 主进程 → 渲染层：webview 内应用快捷键转发（统一拦截点，确保 webview 焦点时可用）
  useEffect(() => {
    const off = onWebviewHotkey((payload) => {
      console.log('[MainView] 收到 webview 快捷键转发:', payload);
      const store = useTabStore.getState();
      if (payload.action === 'switchTab') {
        const index = (payload.data as { index: number })?.index;
        if (typeof index === 'number') {
          const tab = store.tabs[index];
          if (tab) store.setActiveTab(tab.id);
        }
      } else if (payload.action === 'cycleTab') {
        const reverse = (payload.data as { reverse?: boolean })?.reverse;
        const { tabs, activeTabId } = store;
        if (tabs.length > 0) {
          const curIdx = tabs.findIndex((t) => t.id === activeTabId);
          const nextIdx = reverse
            ? curIdx < 0 ? 0 : (curIdx - 1 + tabs.length) % tabs.length
            : curIdx < 0 ? 0 : (curIdx + 1) % tabs.length;
          store.setActiveTab(tabs[nextIdx].id);
        }
      } else if (payload.action === 'toggleSpatialNav') {
        // 切换当前激活 webview 的空间导航模式
        const activeTabId = store.activeTabId;
        if (!activeTabId) return;
        const wv = document.querySelector(`webview[data-tab-id="${activeTabId}"]`) as WebviewElement | null;
        if (!wv) return;
        wv.executeJavaScript(
          'window.__ai_spatial_nav__ && window.__ai_spatial_nav__.toggle(!window.__ai_spatial_nav__.isEnabled())',
        ).catch((e) => console.warn('[main-view] 操作失败:', e));
      } else if (payload.action === 'openShortcuts') {
        setShortcutsOpen((prev) => !prev);
      } else if (payload.action === 'toggleTheme') {
        useThemeStore.getState().toggleTheme();
      } else if (payload.action === 'navBack' || payload.action === 'navForward' || payload.action === 'navRefresh') {
        // F4/F6/F5：当前标签导航控制（与顶栏后退/前进/刷新按钮共用 webview）
        const activeTabId = store.activeTabId;
        if (!activeTabId) return;
        const wv = document.querySelector(`webview[data-tab-id="${activeTabId}"]`) as WebviewElement | null;
        if (!wv) return;
        try {
          if (payload.action === 'navBack' && wv.canGoBack()) wv.goBack();
          else if (payload.action === 'navForward' && wv.canGoForward()) wv.goForward();
          else if (payload.action === 'navRefresh') {
            // 刷新：使用 safeReloadWebview 处理 guest 进程崩溃后的 ERR_FAILED
            const tab = store.tabs.find((t) => t.id === activeTabId);
            const prof = tab ? useProfileStore.getState().profiles.find((p) => p.id === tab.profileId) : null;
            const url = (tab?.url || prof?.aiPlatformUrl || '') as string;
            safeReloadWebview(wv, url, activeTabDomReadyRef.current);
          }
        } catch (e) {
          console.error(`[MainView] ${payload.action} 失败:`, e);
        }
      } else if (payload.action === 'detachCurrent') {
        // Ctrl+T：脱离当前激活标签为独立窗口
        if (store.activeTabId) void detachTab(store.activeTabId);
      } else if (payload.action === 'newTab') {
        // Ctrl+T（旧路径，保留兼容）：新建标签（优先 DeepSeek，其次第一个 AI 平台，最后第一个 profile）
        const { profiles } = useProfileStore.getState();
        const target =
          profiles.find((p) => p.isAIPlatform && p.aiPlatformUrl?.includes('deepseek')) ??
          profiles.find((p) => p.isAIPlatform) ??
          profiles[0];
        if (target) void addTab(target);
      } else if (payload.action === 'closeTab') {
        // Ctrl+W：关闭当前激活标签
        if (store.activeTabId) void closeTab(store.activeTabId);
      }
    });
    return off;
  }, [addTab, closeTab, detachTab]);

  // 反引号(` ~) / ? 呼出快捷键说明窗口（与主进程 before-input-event 拦截分支对应）
  useShortcutsToggle(shortcutsOpen, setShortcutsOpen);

  // 监听主进程请求：Alt+Q 无对话窗口时，打开设置面板的自定义对话配置
  useEffect(() => {
    const off = onChatRequestConfig(() => {
      void openSettingsWindow();
    });
    return off;
  }, []);

  // 过滤平台列表：自动屏蔽国外模型（region === 'global'）+ 用户手动隐藏
  // 注意：底栏/左上角展示此过滤结果；设置面板仍显示全部（含已隐藏）以便管理
  const filterPlatforms = useCallback(
    (list: AIPlatform[], hidden: string[], hideForeign: boolean): AIPlatform[] => {
      let result = list;
      if (hideForeign) {
        result = result.filter((p) => p.region !== 'global');
      }
      if (hidden.length > 0) {
        result = result.filter((p) => !hidden.includes(p.id));
      }
      return result;
    },
    [],
  );

  // 关键修复：当 hiddenPlatforms / hideForeignModels 变化时，立即重新过滤平台列表。
  useEffect(() => {
    if (allPlatforms.length === 0) {
      // allPlatforms 还没加载完成，先用预设列表兜底
      setPlatforms(getPresetAIPlatforms());
      return;
    }
    const filtered = filterPlatforms(allPlatforms, hiddenPlatforms, hideForeignModels);
    setPlatforms(filtered.length > 0 ? filtered : getPresetAIPlatforms());
  }, [hiddenPlatforms, hideForeignModels, allPlatforms, filterPlatforms]);

  // 加载 AI 平台列表 + 应用设置（首次挂载）
  // 关键修复：平台列表是本地预置配置，应同步直出、立即渲染。
  // - platforms 初值已用 getPresetAIPlatforms() 同步填充，UI 立即可用
  // - 此处仅静默调用 listAIPlatforms() 获取 Profile 合并后的完整列表，后台更新
  // - 不显示 loading/错误/重试状态（本地配置读取不应有这些 UX）
  // - getAppSettings 失败时用默认值，不阻塞 platforms 渲染
  useEffect(() => {
    let cancelled = false
    Promise.allSettled([listAIPlatforms(), getAppSettings()])
      .then(([platResult, appResult]) => {
        if (cancelled) return
        // ===== 平台列表静默更新 =====
        if (platResult.status === 'fulfilled') {
          const platList = platResult.value
          setAllPlatforms(platList)
          const hidden =
            appResult.status === 'fulfilled'
              ? (appResult.value.hiddenPlatforms ?? [])
              : []
          const hideForeign =
            appResult.status === 'fulfilled'
              ? (appResult.value.hideForeignModels ?? true)
              : true
          setHiddenPlatforms(hidden)
          setHideForeignModels(hideForeign)
          const filtered = filterPlatforms(platList, hidden, hideForeign)
          // 关键修复：如果过滤后为空（比如 hiddenPlatforms 包含全部），
          // 回退到显示全部预置平台（保证"平台默认 URL 中的全部"立即可用）。
          setPlatforms(filtered.length > 0 ? filtered : getPresetAIPlatforms())
          console.log(
            '[MainView] 平台列表静默更新完成:',
            platList.length,
            '个，过滤后:',
            filtered.length,
            '个',
          )
        } else {
          console.error('[MainView] listAIPlatforms 失败（不影响渲染）:', platResult.reason)
          // 不显示错误状态，保持预设列表继续渲染
        }
        // ===== 应用设置静默更新 =====
        if (appResult.status === 'fulfilled') {
          const appCfg = appResult.value
          setIsTabBarCollapsed(appCfg.tabBarCollapsed ?? true)
          setEnterToSend(appCfg.enterToSend ?? true)
          setTopBarVisibleButtons(appCfg.topBarVisibleButtons ?? [...ALL_TOP_BAR_BUTTON_GROUPS])
          setAppClickBehavior(appCfg.appClickBehavior ?? 'switch')
        } else {
          console.error('[MainView] getAppSettings 失败，使用默认值:', appResult.reason)
          setIsTabBarCollapsed(true)
          setEnterToSend(true)
        }
      })
      .catch((e) => {
        if (cancelled) return
        console.error('[MainView] 平台/设置加载链异常（不影响渲染）:', e)
      })
    return () => {
      cancelled = true
    }
  }, [filterPlatforms])

  // 窗口重新显示时（从托盘恢复/第二实例唤醒）静默刷新平台列表
  useEffect(() => {
    const reload = () => {
      // 不检查 platforms.length，直接静默刷新（本地配置读取极快）
      console.log('[MainView] 窗口重新显示，静默刷新平台列表...')
      Promise.allSettled([listAIPlatforms(), getAppSettings()])
        .then(([platResult, appResult]) => {
          if (platResult.status === 'fulfilled') {
            const platList = platResult.value
            setAllPlatforms(platList)
            // 注意：platforms 过滤由上面的 useEffect（依赖 shouldHideForeignModels/hiddenPlatforms）自动处理，
            // 这里只更新 allPlatforms，不再重复 setPlatforms，避免竞态。
          } else {
            console.error('[MainView] 重新加载 listAIPlatforms 失败（不影响渲染）:', platResult.reason)
          }
          if (appResult.status === 'fulfilled') {
            const cfg = appResult.value
            setHiddenPlatforms(cfg.hiddenPlatforms ?? [])
            setHideForeignModels(cfg.hideForeignModels ?? true)
            setIsTabBarCollapsed(cfg.tabBarCollapsed ?? true)
            setEnterToSend(cfg.enterToSend ?? true)
            setTopBarVisibleButtons(cfg.topBarVisibleButtons ?? [...ALL_TOP_BAR_BUTTON_GROUPS])
            setAppClickBehavior(cfg.appClickBehavior ?? 'switch')
          } else {
            console.error('[MainView] 重新加载 getAppSettings 失败（不影响渲染）:', appResult.reason)
          }
        })
        .catch((e) => console.error('重新加载平台列表链异常:', e))
    }
    const off = onWindowShown(reload)
    return off
  }, [filterPlatforms])

  // 窗口重新显示时，重新加载设置以应用最新的 hiddenPlatforms / hideForeignModels / tabBarCollapsed
  // （设置已改为独立窗口，主窗口每次获得焦点时刷新即可）
  useEffect(() => {
    getAppSettings()
      .then((cfg) => {
        const hiddenChanged = JSON.stringify(cfg.hiddenPlatforms ?? []) !== JSON.stringify(hiddenPlatforms);
        if (hiddenChanged) setHiddenPlatforms(cfg.hiddenPlatforms ?? []);
        const foreignChanged = (cfg.hideForeignModels ?? true) !== hideForeignModels;
        if (foreignChanged) setHideForeignModels(cfg.hideForeignModels ?? true);
        setIsTabBarCollapsed(cfg.tabBarCollapsed ?? true);
        setEnterToSend(cfg.enterToSend ?? true);
        setTopBarVisibleButtons(cfg.topBarVisibleButtons ?? [...ALL_TOP_BAR_BUTTON_GROUPS]);
        setAppClickBehavior(cfg.appClickBehavior ?? 'switch');
      })
      .catch((e) => console.warn('[main-view] 操作失败:', e));
  }, [hiddenPlatforms, hideForeignModels]);

  // 默认首次打开 DeepSeek（无标签时，initialized 保证 stores 已就绪）
  // 若用户设置 startupOpen='lastConversation' 且存在历史对话 URL，则加载该 URL
  useEffect(() => {
    console.log('[MainView] defaultDeepSeek effect: initialized=', initialized, 'tabs=', tabs.length, 'profiles=', profiles.length);
    if (!initialized || tabs.length > 0 || profiles.length === 0) {
      console.log('[MainView] defaultDeepSeek: 跳过（条件不满足）');
      return;
    }
    const deepseek = profiles.find(
      (p) => p.isAIPlatform && p.aiPlatformUrl?.includes('deepseek'),
    );
    const target =
      deepseek ?? profiles.find((p) => p.isAIPlatform) ?? profiles[0];
    console.log('[MainView] defaultDeepSeek: 目标 profile=', target?.name, target?.id);
    if (!target) return;

    // 读取启动设置：home=平台首页 / lastConversation=最近对话地址
    void (async () => {
      try {
        const cfg = await getAppSettings();
        if (cfg.startupOpen === 'lastConversation') {
          const lastUrl = await getLastConversationUrl(target.id);
          if (lastUrl) {
            console.log('[MainView] defaultDeepSeek: startupOpen=lastConversation, 加载最近对话 URL:', lastUrl);
            await addTab(target, { url: lastUrl });
            return;
          }
          console.log('[MainView] defaultDeepSeek: startupOpen=lastConversation 但无历史 URL，回退首页');
        }
      } catch (e) {
        console.warn('[MainView] 读取 startupOpen 失败，回退首页:', e);
      }
      void addTab(target);
    })();
  }, [initialized, tabs.length, profiles, addTab]);

  // 同步初始最大化态
  useEffect(() => {
    if (!initialized) return;
    isWindowMaximized()
      .then((m) => setMaximized(m))
      .catch((e) => console.warn('[main-view] 操作失败:', e));
  }, [initialized, setMaximized]);

  // 编辑标题：进入编辑态
  const startEditTitle = useCallback(() => {
    const active = tabs.find((t) => t.id === activeTabId);
    if (!active) return;
    setTitleDraft(active.title);
    setIsEditingTitle(true);
    requestAnimationFrame(() => titleInputRef.current?.select());
  }, [tabs, activeTabId]);

  // 提交标题
  const commitTitle = useCallback(() => {
    if (!isEditingTitle) return;
    const active = tabs.find((t) => t.id === activeTabId);
    if (active) {
      const trimmed = titleDraft.trim();
      if (trimmed && trimmed !== active.title) {
        // 唯一性校验：与其他 tab title 重复时仅 warn 提示，仍允许提交
        const duplicate = tabs.find((t) => t.id !== active.id && t.title === trimmed);
        if (duplicate) {
          console.warn(`[MainView] 标题「${trimmed}」与其它标签重复（tab ${duplicate.id}）`);
        }
        void renameTab(active.id, trimmed);
        // 同步更新 profile.name（与 AI 应用编辑窗口的名称修改保持一致）
        const profile = profiles.find((p) => p.id === active.profileId);
        if (profile && profile.name !== trimmed) {
          void updateProfile(active.profileId, { name: trimmed });
        }
      }
    }
    setIsEditingTitle(false);
  }, [isEditingTitle, tabs, activeTabId, titleDraft, renameTab, profiles, updateProfile]);

  // 最大化切换
  const handleMaximize = useCallback(() => {
    useTabStore.getState().toggleMaximize();
  }, []);

  // 导航能力状态（由 WebviewTab 上报 + 切换标签时主动查询，控制顶栏后退/前进按钮 disabled）
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  // 当前激活标签的 dom-ready 状态（由 WebviewTab 上报，控制刷新/主页按钮是否可操作）
  const [activeTabDomReady, setActiveTabDomReady] = useState(false);
  // Ref 镜像：供 onWebviewHotkey 回调内读取最新值，避免闭包过期
  const activeTabDomReadyRef = useRef(false);
  useEffect(() => { activeTabDomReadyRef.current = activeTabDomReady; }, [activeTabDomReady]);

  // 需求 2：注入预览浮层状态 + 待注入上下文（pending）
  // - previewState 控制浮层显隐与初始内容
  // - pendingInjectionRef 保存实际注入所需的 webview/selector/template 等
  const [previewState, setPreviewState] = useState<{
    open: boolean;
    composedText: string;
    similarRecords: SimilarInjectionResult[];
  }>({ open: false, composedText: '', similarRecords: [] });
  const pendingInjectionRef = useRef<{
    template: PromptTemplate;
    source: 'inline' | 'detached';
    webview: WebviewLike;
    selector: string | null;
    platformName?: string;
    /** Promise resolve —— 用户确认/取消预览浮层后回传实际结果 */
    resolve: (result: { success: boolean; platformName?: string }) => void;
  } | null>(null);

  // 获取当前激活标签的 webview（用于导航控制）
  const getActiveWebview = useCallback((): WebviewElement | null => {
    if (!activeTabId) return null;
    return document.querySelector(`webview[data-tab-id="${activeTabId}"]`) as WebviewElement | null;
  }, [activeTabId]);

  // 切换标签时主动查询当前 webview 的导航能力（webview 已 ready 不会再次触发 dom-ready）
  useEffect(() => {
    if (!activeTabId) { setCanGoBack(false); setCanGoForward(false); setActiveTabDomReady(false); return; }
    const wv = document.querySelector(`webview[data-tab-id="${activeTabId}"]`) as WebviewElement | null;
    if (wv) {
      try { setCanGoBack(wv.canGoBack()); setCanGoForward(wv.canGoForward()); } catch { /* ignore */ }
      // 切换标签时重置 dom-ready 状态（WebviewTab 会在下次 dom-ready 时重新上报 true）
      // 已 ready 的 webview 不会再次触发 dom-ready，所以这里保守设为 true（webview 存在即视为 ready）
      setActiveTabDomReady(true);
    } else {
      setCanGoBack(false); setCanGoForward(false);
      setActiveTabDomReady(false);
    }
  }, [activeTabId]);

  // 导航：后退 / 前进 / 刷新 / 主页
  const handleGoBack = useCallback(() => {
    const wv = getActiveWebview();
    try {
      if (wv && wv.canGoBack()) wv.goBack();
    } catch (e) {
      console.error('[MainView] goBack 失败:', e);
    }
  }, [getActiveWebview]);

  const handleGoForward = useCallback(() => {
    const wv = getActiveWebview();
    try {
      if (wv && wv.canGoForward()) wv.goForward();
    } catch (e) {
      console.error('[MainView] goForward 失败:', e);
    }
  }, [getActiveWebview]);

  const handleReload = useCallback(() => {
    const wv = getActiveWebview();
    if (!wv) return;
    const tab = tabs.find((t) => t.id === activeTabId);
    const profile = tab ? profiles.find((p) => p.id === tab.profileId) : null;
    const fallbackUrl = (tab?.url || profile?.aiPlatformUrl || '') as string;
    safeReloadWebview(wv, fallbackUrl, activeTabDomReadyRef.current);
  }, [getActiveWebview, tabs, activeTabId, profiles]);

  const handleGoHome = useCallback(() => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return;
    const profile = profiles.find((p) => p.id === tab.profileId);
    let homeUrl = tab.homeUrl || profile?.aiPlatformUrl || tab.url;
    // 兜底：从 AI_PLATFORMS 预设按 aiPlatformId 取默认 URL（智谱清言验证页等场景 homeUrl 可能为空）
    if (!homeUrl && profile?.aiPlatformId) {
      const preset = getPresetAIPlatforms().find((p) => p.id === profile.aiPlatformId);
      if (preset) homeUrl = preset.url;
    }
    if (!homeUrl) return;
    const wv = getActiveWebview();
    if (!wv) return;
    // 使用 safeLoadURLWebview 处理 loadURL 的异步 Promise 失败（ERR_FAILED）
    safeLoadURLWebview(wv, homeUrl);
  }, [tabs, activeTabId, profiles, getActiveWebview]);

  // 关闭当前激活标签
  const handleCloseActiveTab = useCallback(() => {
    if (activeTabId) void closeTab(activeTabId);
  }, [activeTabId, closeTab]);

  // 底栏红条：点击切换展开/收起（高度固定，不可拖拽调整）
  const handleHandleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      toggleBottomBar();
    },
    [toggleBottomBar],
  );

  // 当前激活标签
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activeTitle = activeTab?.title ?? '工百窗';

  // 标题/顶栏按钮变化时动态更新窗口最小宽度
  // 拖拽区宽度按标题文本宽度 × 2 计算（100% 余量），标题变长时 minWidth 需同步增大
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cfg = await getAppSettings();
        if (cancelled) return;
        const isOxy = useUiVersionStore.getState().version === 'oxy';
        if (isOxy) {
          const oxyLayout = getOxyLayout();
          if (oxyLayout) {
            const minWidth = calculateOxyMainWindowMinWidthByScale(oxyLayout.scale, topBarVisibleButtons, activeTitle);
            await setMinimumSize(minWidth, MAIN_WINDOW_MIN_HEIGHT);
            return;
          }
        }
        const uiScale = (cfg.uiScale ?? 'medium') as UiScale;
        const minWidth = calculateMainWindowMinWidth(uiScale, topBarVisibleButtons, activeTitle);
        await setMinimumSize(minWidth, MAIN_WINDOW_MIN_HEIGHT);
      } catch (e) {
        console.warn('[MainView] 标题变化更新 minWidth 失败:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [activeTitle, topBarVisibleButtons]);

  // Oxy 模式：切换标签时动态注入当前 app 的主题色
  const uiVersion = useUiVersionStore((s) => s.version);
  const isOxy = uiVersion === 'oxy';
  useEffect(() => {
    if (!isOxy) return;
    if (!activeTabId) return;
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return;
    const profile = profiles.find((p) => p.id === tab.profileId);
    const platform = profile?.isAIPlatform
      ? platforms.find((p) => p.id === profile.aiPlatformId || p.url === profile.aiPlatformUrl)
      : null;
    const { themeColor } = getPlatformColors(profile, platform, tab.profileId);
    applyAppTheme(themeColor);
  }, [isOxy, activeTabId, tabs, profiles, platforms]);

  // Oxy 模式：标签栏强制收起
  const effectiveTabBarCollapsed = isOxy ? true : isTabBarCollapsed;

  // 当前激活标签对应的 Profile（用于顶栏 UA 锁定按钮状态）
  const activeProfile = activeTab ? (profiles.find((p) => p.id === activeTab.profileId) ?? null) : null;
  const activeUaLockMode = activeProfile?.uaLockMode;

  /**
   * 循环切换 UA 锁定模式：auto → mobile → desktop → auto
   * 持久化到当前激活标签对应的 Profile 级。
   */
  const handleToggleUaLockMode = useCallback(() => {
    if (!activeProfile) return;
    const current = activeProfile.uaLockMode ?? 'auto';
    const next: 'auto' | 'mobile' | 'desktop' =
      current === 'auto' ? 'mobile' : current === 'mobile' ? 'desktop' : 'auto';
    void updateProfileUaLockMode(activeProfile.id, next);
  }, [activeProfile, updateProfileUaLockMode]);

  // profile 查找
  const getProfile = useCallback(
    (profileId: string) => profiles.find((p) => p.id === profileId) ?? null,
    [profiles],
  );

  // 已打开标签的 profileId 集合（用于应用网格高亮）
  const openProfileIds = useMemo(
    () => new Set(tabs.map((t) => t.profileId)),
    [tabs],
  );

  const handleAppClick = useCallback(
    (profile: Profile) => {
      // 按 profileId 查找该应用对应的已打开标签（一个应用只允许一个标签）
      const existingTab = tabs.find((t) => t.profileId === profile.id);
      if (existingTab && existingTab.id === activeTabId) {
        // 当前页面就是该应用：依据 appClickBehavior 决定行为
        if (appClickBehavior === 'close') {
          // close 模式：关闭该标签（session partition 持久化保留）
          // 注：BottomBar/AppSwitcher 在 close 模式下会做二次确认（pending 提示），到达此处的点击已是确认后的关闭
          void closeTab(existingTab.id);
        } else {
          // switch 模式（默认）：仅切换到该标签，不关闭
          setActiveTab(existingTab.id);
        }
      } else {
        // 已打开但非当前 / 未打开：addTab 内部会切换到已存在标签或新建
        void addTab(profile);
      }
    },
    [addTab, closeTab, tabs, activeTabId, appClickBehavior],
  );

  // 提示词注入：找到激活标签的 webview + 平台选择器，准备注入
  // 需求 1：接收完整 PromptTemplate，读取当前输入框内容（body），
  //        调用 composeFinalText 替换 {{body}} 占位符
  // 需求 2：组合完成后查询最近注入历史中相似度 ≥ 0.85 的记录，弹出预览浮层供用户确认/编辑
  const handleInjectPrompt = useCallback(
    async (
      template: PromptTemplate,
      source: 'inline' | 'detached' = 'inline',
      skipPreview = false,
    ): Promise<{ success: boolean; platformName?: string }> => {
      const tab = activeTab;
      if (!tab) return { success: false };
      const profile = getProfile(tab.profileId);
      const platform = profile?.aiPlatformUrl
        ? platforms.find((p) => p.url === profile.aiPlatformUrl)
        : undefined;
      const selector = profile?.aiInputSelector || platform?.inputSelector || null;
      const el = document.querySelector(`webview[data-tab-id="${tab.id}"]`) as WebviewLike | null;
      if (!el) return { success: false };

      // 需求 1：读取当前输入框内容作为 {{body}} 占位符值
      let selection = '';
      try {
        const script = `(function(sel) {
          var el = null;
          if (sel) {
            var parts = sel.split(',');
            for (var i = 0; i < parts.length; i++) {
              var found = document.querySelector(parts[i].trim());
              if (found) { el = found; break; }
            }
          }
          if (!el) el = document.querySelector('textarea:not([disabled]):not([readonly])')
                 || document.querySelector('input[type=text]:not([disabled]):not([readonly])')
                 || document.querySelector('div[contenteditable=true]');
          if (!el) return '';
          if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
          if (el.isContentEditable) return el.innerText || el.textContent || '';
          return '';
        })(${JSON.stringify(selector)})`;
        const result = await el.executeJavaScript(script);
        selection = typeof result === 'string' ? result : '';
      } catch (e) {
        console.warn('[MainView] 读取 webview 输入框内容失败:', e);
      }

      const composedText = composeFinalText(template, { body: selection });

      // skipPreview：双击快捷键跳过预览，直接注入（不查询相似度、不弹浮层）
      if (skipPreview) {
        const ok = await injectTextToWebview(el, composedText, selector);
        try {
          await logInjection({
            composedText,
            templateId: template.id,
            windowId: source === 'detached' ? 'detached-prompt-window' : 'main',
          });
        } catch (e) {
          console.warn('[MainView] 记录注入历史失败:', e);
        }
        if (source === 'detached') {
          sendPromptInjectResult({ success: ok, platformName: platform?.name });
        }
        return { success: ok, platformName: platform?.name };
      }

      // 需求 2：查询最近注入历史中相似度 ≥ 0.85 的记录
      let similarRecords: SimilarInjectionResult[] = [];
      try {
        similarRecords = await findSimilarInjection(composedText, 20, 0.85);
      } catch (e) {
        console.warn('[MainView] 查询相似注入记录失败:', e);
      }

      // 弹出预览浮层（用户确认后才执行实际注入）
      // 返回的 Promise 在 handleConfirmInjection / handleCancelInjection 中 resolve
      return new Promise<{ success: boolean; platformName?: string }>((resolve) => {
        pendingInjectionRef.current = {
          template,
          source,
          webview: el,
          selector,
          platformName: platform?.name,
          resolve,
        };
        setPreviewState({
          open: true,
          composedText,
          similarRecords,
        });
      });
    },
    [activeTab, getProfile, platforms],
  );

  // 需求 2：预览浮层确认 → 记录注入历史 + 实际注入 + 回传结果（detached 模式）
  const handleConfirmInjection = useCallback(
    async (editedText: string) => {
      const pending = pendingInjectionRef.current;
      if (!pending) {
        setPreviewState((s) => ({ ...s, open: false }));
        return;
      }
      const { template, source, webview, selector, platformName, resolve } = pending;
      const ok = await injectTextToWebview(webview, editedText, selector);
      // 记录注入历史（需求 2：供后续相似度查询）
      try {
        await logInjection({
          composedText: editedText,
          templateId: template.id,
          windowId: source === 'detached' ? 'detached-prompt-window' : 'main',
        });
      } catch (e) {
        console.warn('[MainView] 记录注入历史失败:', e);
      }
      if (source === 'detached') {
        sendPromptInjectResult({ success: ok, platformName });
      }
      resolve({ success: ok, platformName });
      pendingInjectionRef.current = null;
      setPreviewState({ open: false, composedText: '', similarRecords: [] });
    },
    [],
  );

  // 需求 2：预览浮层取消 → 清理状态 + 回传失败结果（detached 模式）
  const handleCancelInjection = useCallback(() => {
    const pending = pendingInjectionRef.current;
    if (!pending) {
      setPreviewState({ open: false, composedText: '', similarRecords: [] });
      return;
    }
    if (pending.source === 'detached') {
      sendPromptInjectResult({ success: false });
    }
    pending.resolve({ success: false });
    pendingInjectionRef.current = null;
    setPreviewState({ open: false, composedText: '', similarRecords: [] });
  }, []);

  // 需求 2.5：提示词局内快捷键 —— 命中时走与 inline 注入相同的流程（弹预览浮层供用户确认）
  // hook 内部使用 useRef 持有最新 onTriggered 回调，不会因 handleInjectPrompt 变化而重注册
  usePromptHotkeys({
    onTriggered: (template, options) => {
      void handleInjectPrompt(template, 'inline', options?.skipPreview);
    },
  });

  // 监听提示词库独立窗口的注入请求：弹预览浮层供用户确认（需求 2）
  // 需求 1：回调接收完整 PromptTemplate，由 handleInjectPrompt 组合后注入
  useEffect(() => {
    const off = onPromptInjectRequest((template) => {
      void (async () => {
        await handleInjectPrompt(template, 'detached');
      })();
    });
    return () => off();
  }, [handleInjectPrompt]);

  // 语音识别结果注入+发送：C1 应用内路径 + B2 后台路径共用
  // 1. 找到激活标签的 webview + 平台选择器
  // 2. injectTextToWebview 填入文本
  // 3. send=true 时调用 triggerSendInWebview 点击发送按钮（回退 Enter keydown）
  //    send=false（后台路径 enterToSend=false）仅填入文本，不自动发送
  // 选择器优先级：Profile 用户覆盖（aiInputSelector/aiSendSelector）> 平台预设
  const injectAndSendVoice = useCallback(
    async (
      text: string,
      send = true,
    ): Promise<void> => {
      if (!text || !text.trim()) return;
      const tab = activeTab;
      if (!tab) {
        console.warn('[MainView] injectAndSendVoice: 无激活标签，跳过');
        return;
      }
      const profile = getProfile(tab.profileId);
      const platform = profile?.aiPlatformUrl
        ? platforms.find((p) => p.url === profile.aiPlatformUrl)
        : undefined;
      // 选择器优先级：Profile 用户覆盖（aiInputSelector/aiSendSelector）> 平台预设
      const inputSelector = profile?.aiInputSelector || platform?.inputSelector || null;
      const sendSelector = profile?.aiSendSelector || platform?.sendSelector || null;
      const el = document.querySelector(`webview[data-tab-id="${tab.id}"]`) as WebviewLike | null;
      if (!el) {
        console.warn('[MainView] injectAndSendVoice: 未找到激活 webview');
        return;
      }
      const ok = await injectTextToWebview(el, text, inputSelector);
      if (!ok) {
        console.warn('[MainView] injectAndSendVoice: 注入失败');
        return;
      }
      if (send) {
        await triggerSendInWebview(el, sendSelector, inputSelector);
      }
    },
    [activeTab, getProfile, platforms],
  );

  // 后台语音注入接收：主进程 STT 识别完成后通过 IPC 通知本渲染层注入激活 webview。
  // 载荷含 enterToSend，由渲染层决定是否自动回车发送。
  // 统一语音 UI 路径：底栏按钮 / Alt+V 均走主进程后台语音（独立预览窗），识别结果由此监听注入。
  useEffect(() => {
    const offInject = onVoiceInjectAndSend(({ text, enterToSend }) => {
      console.log('[MainView] 收到后台语音注入指令，enterToSend=', enterToSend);
      void injectAndSendVoice(text, enterToSend);
    });
    return () => {
      offInject();
    };
  }, [injectAndSendVoice]);

  // 右键菜单状态与处理逻辑（抽离到 useTabContextMenu）
  const {
    contextMenuTabId,
    contextMenuPosition,
    urlDraft,
    editingTabUrl,
    urlInputRef,
    contextMenuHomeUrl,
    contextMenuIsAiPlatform,
    closeContextMenu,
    refreshTab,
    clearTabData,
    closeOtherTabs,
    closeTabsToRight,
    setAsAIHome,
    configureApp,
    handleTabContextMenu,
    commitTabUrl,
    setUrlDraft,
    setEditingTabUrl,
  } = useTabContextMenu({
    tabs,
    getProfile,
    closeTab,
    updateTabUrl,
    updateTabHomeUrl,
    isTabDomReady: (tabId: string) => tabId === activeTabId ? activeTabDomReadyRef.current : true,
  });

  // 标签拖拽排序
  const [hoverTabId, setHoverTabId] = useState<string | null>(null);
  const handleTabDragOver = useCallback((e: React.DragEvent, targetTabId: string) => {
    e.preventDefault();
    if (draggingTabId && draggingTabId !== targetTabId) {
      setHoverTabId(targetTabId);
    }
  }, [draggingTabId]);

  const handleTabDrop = useCallback((e: React.DragEvent, targetTabId: string) => {
    e.preventDefault();
    if (draggingTabId && draggingTabId !== targetTabId) {
      moveTab(draggingTabId, targetTabId);
    }
    setHoverTabId(null);
  }, [draggingTabId, moveTab]);

  // 标签拖拽复制：拖动 tab-chip 到窗口外释放 → 复制为独立窗口
  const handleTabDragStart = useCallback((e: React.DragEvent, tabId: string) => {
    draggingTabRef.current = tabId;
    setDraggingTabId(tabId);
    e.dataTransfer.effectAllowed = 'move';
    // 设置数据，部分环境需要才能触发 dragend
    e.dataTransfer.setData('text/plain', tabId);
  }, []);

  const handleTabDragEnd = useCallback(
    async (e: React.DragEvent) => {
      const tabId = draggingTabRef.current;
      draggingTabRef.current = null;
      setDraggingTabId(null);
      setHoverTabId(null);
      if (!tabId) return;
      // 判断光标是否在当前窗口外（屏幕坐标 vs 窗口 bounds）
      const { screenX, screenY } = e;
      try {
        const bounds = await getWindowBounds();
        const outside =
          screenX < (bounds.x ?? 0) ||
          screenX > (bounds.x ?? 0) + bounds.width ||
          screenY < (bounds.y ?? 0) ||
          screenY > (bounds.y ?? 0) + bounds.height;
        if (outside) {
          void detachTab(tabId);
        }
      } catch (err) {
        console.error('[MainView] 拖拽脱离判断失败:', err);
      }
    },
    [detachTab],
  );

  return (
    <>
      <div
        className="main-view app-shell"
        data-viewport={isNarrow ? 'narrow' : 'wide'}
        data-oxy={isOxy ? 'true' : undefined}
        data-name="main.main-view.container"
      >
        {/* ===== 顶栏（常驻显示：AppSwitcher + 导航 + 居中标题 + 菜单/置顶/窗口控制） ===== */}
        <TopBar
          data={{
            editingTitle: isEditingTitle,
            titleDraft,
            alwaysOnTop,
            isMaximized,
            activeTitle,
            hasActiveTab: !!activeTabId,
            canGoBack,
            canGoForward,
            activeTabDomReady,
            titleInputRef,
            platforms,
            isDark: isDarkTheme,
            isNarrow,
            uaLockMode: activeUaLockMode,
            hasActiveProfile: !!activeProfile,
            visibleButtons: topBarVisibleButtons,
            onAppClick: handleAppClick,
            appClickBehavior,
            activeProfileId: activeTab?.profileId ?? null,
          }}
          actions={{
            startEditTitle,
            commitTitle,
            setTitleDraft,
            setEditingTitle: setIsEditingTitle,
            handleGoBack,
            handleGoForward,
            handleReload,
            handleGoHome,
            handleMaximize,
            handleTogglePin: () => useTabStore.getState().toggleAlwaysOnTop(),
            setDrawerOpen,
            onOpenSettings: () => void openSettingsWindow(),
            onToggleTheme: () => useThemeStore.getState().toggleTheme(),
            onToggleUaLockMode: handleToggleUaLockMode,
          }}
        />

        {/* ===== 标签栏：不做横向滚动，自动压缩宽度，首页标签不显示域名 ===== */}
        <TabBar
          data={{
            tabs,
            activeTabId,
            draggingTabId,
            hoverTabId,
            collapsed: effectiveTabBarCollapsed,
            platforms,
            maxRows: isOxy ? 2 : 1,
          }}
          actions={{
            getProfile,
            setActiveTab,
            closeTab,
            onTabContextMenu: handleTabContextMenu,
            onTabDragStart: handleTabDragStart,
            onTabDragOver: handleTabDragOver,
            onTabDrop: handleTabDrop,
            onTabDragEnd: handleTabDragEnd,
          }}
        />

        {/* ===== 中央：多 webview（仅激活可见） ===== */}
        <div className="webview-container" data-name="main.main-view.webview-container">
          {tabs.map((tab) => {
            const profile = getProfile(tab.profileId);
            if (!profile) return null;
            const platform = profile.isAIPlatform
              ? platforms.find((p) => p.id === profile.aiPlatformId || p.url === profile.aiPlatformUrl)
              : null;
            // 桌面端/移动端 UA 预设：AI 平台用平台自定义预设，普通 Profile 用全局默认
            const desktopPresetId = platform?.defaultDesktopPreset ?? 'win-chrome-125';
            const mobilePresetId = platform?.defaultMobilePreset ?? 'iphone-15-pro-safari';
            return (
              <WebviewTab
                key={tab.id}
                tab={tab}
                profile={profile}
                active={tab.id === activeTabId}
                isNarrow={isNarrow}
                desktopPresetId={desktopPresetId}
                mobilePresetId={mobilePresetId}
                inputSelector={profile?.aiInputSelector || platform?.inputSelector || null}
                sendSelector={profile?.aiSendSelector || platform?.sendSelector || null}
                enterToSend={enterToSend}
                onNavigationChange={(back, fwd) => {
                  // 仅更新激活标签的导航状态（所有 webview 均已挂载，会同时上报）
                  if (tab.id === activeTabId) {
                    setCanGoBack(back);
                    setCanGoForward(fwd);
                  }
                }}
                onDomReadyChange={(isReady) => {
                  // 仅更新激活标签的 dom-ready 状态
                  if (tab.id === activeTabId) {
                    setActiveTabDomReady(isReady);
                  }
                }}
                onProcessGone={(reason) => {
                  // WebviewTab 已自动尝试 loadURL(src) 恢复；这里仅记录日志，
                  // 并在崩溃 tab 为当前激活 tab 时重置 dom-ready 状态（按钮禁用直至恢复完成）
                  console.warn('[MainView] webview 进程崩溃，已触发自动恢复:', tab.id, reason);
                  if (tab.id === activeTabId) {
                    setActiveTabDomReady(false);
                  }
                }}
              />
            );
          })}
        </div>

        {/* ===== 底栏遮罩：展开时覆盖正文区域，点击收起（webview 原生组件不冒泡，遮罩可拦截） ===== */}
        {bottomBarExpanded && (
          <div
            className="bottom-bar-overlay"
            onClick={() => toggleBottomBar()}
            aria-hidden="true"
            data-name="main.main-view.bottom-overlay"
          />
        )}

        {/* ===== 底栏（抽屉式：收起仅露 8px 渐变手柄，点击展开） ===== */}
        <BottomBar
          expanded={bottomBarExpanded}
          height={bottomBarHeight}
          platforms={platforms}
          openProfileIds={openProfileIds}
          callbacks={{
            onAppClick: handleAppClick,
            onInjectPrompt: handleInjectPrompt,
            onOpenSettings: () => void openSettingsWindow(),
            onOpenShortcuts: () => setShortcutsOpen(true),
            onToggle: toggleBottomBar,
            onHandleClick: handleHandleClick,
          }}
          appClickBehavior={appClickBehavior}
          activeProfileId={activeTab?.profileId ?? null}
        />

        {/* 三点菜单抽屉（v2：右侧 280px 滑入） */}
        <DrawerPanel
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          onOpenSearch={() => void openHistoryWindow()}
          onOpenShortcuts={() => setShortcutsOpen(true)}
          onOpenSettings={() => void openSettingsWindow()}
          onOpenPromptLibrary={() => void openPromptWindow()}
        />

        {/* 快捷键查看弹窗 */}
        <ShortcutsModal
          open={shortcutsOpen}
          onClose={() => setShortcutsOpen(false)}
          hotkeys={hotkeys}
        />

        {/* 自定义窗口边缘 resize（配合 thickFrame:false）；底栏展开时释放限制，允许调整窗口大小 */}
        <WindowResizeHandles />

        {/* 标签右键菜单 */}
        {contextMenuPosition && contextMenuTabId && (
          <TabContextMenu
            position={contextMenuPosition}
            tabId={contextMenuTabId}
            homeUrl={contextMenuHomeUrl}
            urlDraft={urlDraft}
            editingTabUrl={editingTabUrl}
            urlInputRef={urlInputRef}
            isAiPlatformTab={contextMenuIsAiPlatform}
            actions={{
              refresh: refreshTab,
              clearData: clearTabData,
              setAsHome: setAsAIHome,
              configureApp,
              detach: detachTab,
              closeOthers: closeOtherTabs,
              closeRight: closeTabsToRight,
              closeTab,
              commitUrl: commitTabUrl,
              setUrlDraft: setUrlDraft,
              setEditingUrl: setEditingTabUrl,
              close: closeContextMenu,
            }}
          />
        )}

        {/* 文件拖拽导入遮罩（仅拖拽中可见，pointer-events:auto 拦截 webview 的 drop） */}
        <FileDropOverlay visible={isDragOver} />

        {/* 下载完成 / 拖拽导入反馈 toast */}
        {downloadToast && (
          <div
            role="status"
            aria-live="polite"
            data-name="main.main-view.download-toast"
            style={{
              position: 'fixed',
              left: '50%',
              bottom: 'calc(var(--space-12, 48px) + var(--space-2, 8px))',
              transform: 'translateX(-50%)',
              padding: '8px 16px',
              background: 'var(--card, #fff)',
              color: 'var(--foreground, #333)',
              border: '1px solid var(--border, #ddd)',
              borderRadius: 6,
              fontSize: 13,
              boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
              zIndex: 100,
              pointerEvents: 'none',
            }}
          >
            {downloadToast}
          </div>
        )}

        {/* 需求 2：注入预览浮层（相似度警告 + 可编辑文本 + 确认/取消） */}
        <InjectionPreviewModal
          open={previewState.open}
          composedText={previewState.composedText}
          similarRecords={previewState.similarRecords}
          onConfirm={handleConfirmInjection}
          onCancel={handleCancelInjection}
        />
      </div>
    </>
  );
}
