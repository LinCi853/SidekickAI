/* =====================================================================
   pages/BrowserView/hooks/useBrowserWebview.ts —— webview 相关逻辑
   职责：
   - getActiveWebview 查询助手
   - webview 导航动作（后退/前进/刷新/停止/强制刷新）
   - 聚焦管理（F6 聚焦循环 / Ctrl+K 聚焦地址栏）
   - 当前页面动作（书签 / 查找 / 打印 / DevTools / 另存为 / 查看源码）
   - 页面缩放（统一动作，快捷键/右键/浮窗共用）
   - 空间导航切换（Ctrl+G）
   - 沉浸式全屏（F11 切换 + 悬浮退出条）
   - 云电脑模式（进入/退出 + 按键路由 + 网站检测提醒 + 内容缩放）
   - 手柄接入（Gamepad API 采集 + guest 桥接）
   - 冻结切换（Alt+P）
   ===================================================================== */

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useBrowserTabStore } from '../../../store/useBrowserTabStore.js';
import { useBookmarkStore } from '../../../store/useBookmarkStore.js';
import { useGamepadStore } from '../../../store/useGamepadStore.js';
import { useCloudPcStore } from '../../../store/useCloudPcStore.js';
import { useZoomStore } from '../../../store/useZoomStore.js';
import { useFreezeStore } from '../../../store/useFreezeStore.js';
import {
  toggleFullscreenWindow,
  exitFullscreenWindow,
  onFullscreenToggled,
  onCloudPcChanged,
  onCloudPcKeys,
  getCursorPos,
  setCloudPcMode,
  savePageAs,
  printPreview,
} from '../../../lib/electron-api/index.js';
import type { BrowserTabState, Profile } from '../../../lib/electron-api/index.js';
import { GamepadCollector } from '../../../lib/cloud-game/index.js';
import { useCloudPcGamepadNav } from '../useCloudPcGamepadNav.js';
import { useCloudPcZoom } from '../useCloudPcZoom.js';
import { INTERNAL_TAB_SOURCES, type WebviewElement } from '../constants.js';

interface UseBrowserWebviewParams {
  webviewContainerRef: MutableRefObject<HTMLDivElement | null>;
  addressBarRef: MutableRefObject<HTMLInputElement | null>;
  activeTabId: string | null;
  profileId: string;
  newTab: (url?: string, opts?: { source?: BrowserTabState['source']; kind?: 'home' | 'web' }) => string;
  activeProfile: Profile | null;
}

export function useBrowserWebview({
  webviewContainerRef,
  addressBarRef,
  activeTabId,
  profileId,
  newTab,
  activeProfile,
}: UseBrowserWebviewParams) {
  /** 获取当前激活标签的 webview 元素 */
  const getActiveWebview = useCallback((): WebviewElement | null => {
    return webviewContainerRef.current?.querySelector(
      `webview[data-tab-id="${activeTabId}"]`,
    ) as WebviewElement | null;
  }, [webviewContainerRef, activeTabId]);

  /* ===== 导航动作 ===== */

  const handleGoBack = useCallback(() => {
    const webview = getActiveWebview();
    if (webview?.canGoBack()) webview.goBack();
  }, [getActiveWebview]);

  const handleGoForward = useCallback(() => {
    const webview = getActiveWebview();
    if (webview?.canGoForward()) webview.goForward();
  }, [getActiveWebview]);

  const handleRefresh = useCallback(() => {
    const webview = getActiveWebview();
    if (webview) {
      webview.reload();
    } else {
      // 内部标签（查看源码/打印预览等）无 webview：派发刷新事件由组件自行刷新
      if (activeTabId) {
        window.dispatchEvent(new CustomEvent('browser-tab-reload', { detail: { tabId: activeTabId } }));
      }
    }
  }, [activeTabId, getActiveWebview]);

  const handleStopLoading = useCallback(() => {
    const webview = getActiveWebview();
    webview?.stop();
  }, [getActiveWebview]);

  const handleForceRefresh = useCallback(() => {
    const webview = getActiveWebview();
    webview?.reloadIgnoringCache();
  }, [getActiveWebview]);

  /* ===== F6 聚焦循环 ===== */
  // 地址栏 → 页面内可输入区域 → 不聚焦（返回页面内容）之间循环
  const handleFocusCycle = useCallback(() => {
    const addressBar = addressBarRef.current;
    // 1. 当前焦点在地址栏 → 聚焦页面内第一个可输入元素
    if (addressBar && document.activeElement === addressBar) {
      const webview = getActiveWebview();
      if (webview) {
        webview.executeJavaScript(
          `(function() {
            var el = document.querySelector('textarea:not([disabled]):not([readonly])')
                   || document.querySelector('input:not([disabled]):not([readonly])')
                   || document.querySelector('div[contenteditable=true]');
            if (el) { el.focus(); return true; }
            return false;
          })()`,
        ).catch(() => {});
      }
      return;
    }
    // 2. 检查 webview 内是否有可输入元素聚焦
    const webview = getActiveWebview();
    if (webview) {
      webview.executeJavaScript(
        `(function() {
          var el = document.activeElement;
          if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
            el.blur();
            return true;
          }
          return false;
        })()`,
      )
        .then((inInput: unknown) => {
          // 3. 焦点不在页面可输入元素 → 聚焦地址栏
          if (!inInput) addressBar?.focus();
        })
        .catch(() => {
          addressBar?.focus();
        });
    } else {
      addressBar?.focus();
    }
  }, [addressBarRef, getActiveWebview]);

  // ref 保证 onWebviewHotkey 监听器能调用最新的 handleFocusCycle
  const focusCycleRef = useRef(handleFocusCycle);
  focusCycleRef.current = handleFocusCycle;

  /* ===== Ctrl+D：添加/取消当前页面书签（toggle 语义：再按取消，不重复添加） ===== */
  const handleAddBookmark = useCallback(() => {
    if (!activeProfile) return;
    const store = useBrowserTabStore.getState();
    const tab = store.tabs.find((t) => t.id === store.activeTabId);
    if (!tab || !tab.url) return;
    const bookmarkStore = useBookmarkStore.getState();
    if (!bookmarkStore.loaded) void bookmarkStore.load();
    // 已存在同 URL 书签 → 取消（移除），避免连按重复添加
    const existing = bookmarkStore.bookmarks.find((bm) => bm.url === tab.url);
    if (existing) {
      void bookmarkStore.remove(existing.id);
      console.log('[BrowserView] Ctrl+D 取消书签:', tab.url);
      return;
    }
    void bookmarkStore.add({
      title: tab.title || tab.url,
      url: tab.url,
      favicon: tab.favicon,
      profileId: activeProfile.id,
      profileName: activeProfile.name,
      aiPlatformId: activeProfile.aiPlatformId,
      inBookmarkBar: true,
    });
  }, [activeProfile]);

  /* ===== Ctrl+K / Ctrl+E：聚焦地址栏并进入搜索模式 ===== */
  const handleFocusSearch = useCallback(() => {
    const addressBar = addressBarRef.current;
    if (addressBar) {
      addressBar.focus();
      addressBar.select();
    }
  }, [addressBarRef]);

  /* ===== Ctrl+F：页内查找（注入 find 脚本） ===== */
  const handleFindInPage = useCallback(() => {
    const webview = getActiveWebview();
    if (!webview) return;
    webview.executeJavaScript(
      `(function() {
        var existing = document.getElementById('__sidekick_find_bar');
        if (existing) { existing.remove(); return; }
        var bar = document.createElement('div');
        bar.id = '__sidekick_find_bar';
        bar.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;background:#fff;color:#333;border:1px solid #ccc;border-radius:4px;padding:6px 8px;box-shadow:0 2px 8px rgba(0,0,0,0.25);font-family:sans-serif;font-size:13px;display:flex;align-items:center;gap:6px;';
        var input = document.createElement('input');
        input.type = 'text';
        input.placeholder = '查找...';
        input.style.cssText = 'border:1px solid #ddd;border-radius:2px;padding:3px 6px;width:180px;outline:none;font-size:13px;';
        var info = document.createElement('span');
        info.style.cssText = 'min-width:40px;color:#666;font-size:12px;';
        var closeBtn = document.createElement('button');
        closeBtn.textContent = '\\u2715';
        closeBtn.style.cssText = 'border:none;background:none;cursor:pointer;font-size:14px;color:#999;padding:0 2px;';
        closeBtn.onclick = function() { bar.remove(); };
        function doFind(reverse) {
          if (!input.value) { info.textContent = ''; return; }
          var found = window.find(input.value, false, reverse, true, false, true, false);
          info.textContent = found ? '' : '未找到';
        }
        input.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') { e.preventDefault(); doFind(e.shiftKey); }
          if (e.key === 'Escape') { e.preventDefault(); bar.remove(); }
        });
        bar.appendChild(input);
        bar.appendChild(info);
        bar.appendChild(closeBtn);
        document.body.appendChild(bar);
        input.focus();
      })()`,
    ).catch(() => {});
  }, [getActiveWebview]);

  /* ===== Ctrl+P：打印当前页面（应用内打印预览） ===== */
  const handlePrint = useCallback(() => {
    const webview = getActiveWebview();
    if (!webview) return;
    let wcId: number | null = null;
    try { wcId = webview.getWebContentsId(); } catch { /* webview 未 attach */ }
    if (wcId === null) return;
    const url = webview.getURL() || '';
    const tab = useBrowserTabStore.getState().tabs.find((t) => t.id === activeTabId);
    const title = (tab?.title || '').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'page';
    void printPreview(wcId, title).then((res) => {
      if (res.ok && res.filePath) {
        const params = new URLSearchParams({ file: res.filePath, title: res.title || title, sourceUrl: url });
        newTab(`sidekickai://print-preview?${params.toString()}`, { source: 'print-preview', kind: 'web' });
      }
    }).catch(() => { /* ignore */ });
  }, [activeTabId, newTab, getActiveWebview]);

  /* ===== 快捷键 ===== */

  const handleToggleDevTools = useCallback(() => {
    if (activeTabId && useFreezeStore.getState().states[activeTabId] === 'frozen') return;
    const webview = getActiveWebview();
    if (!webview) return;
    if (webview.isDevToolsOpened()) webview.closeDevTools();
    else webview.openDevTools();
  }, [activeTabId, getActiveWebview]);

  /* ===== Ctrl+S 另存为 / Ctrl+U 查看源码（webview 级，含右键菜单复用） ===== */

  // Ctrl+S：另存为当前激活标签的页面
  const handleSavePageAs = useCallback(() => {
    const webview = getActiveWebview();
    if (!webview) return;
    let wcId: number | null = null;
    try { wcId = webview.getWebContentsId(); } catch { /* webview 未 attach */ }
    if (wcId === null) return;
    const url = webview.getURL() || '';
    const tab = useBrowserTabStore.getState().tabs.find((t) => t.id === activeTabId);
    // 从标题或 URL 推导默认文件名
    const title = (tab?.title || '').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    void savePageAs(wcId, title || 'page').catch(() => { /* ignore */ });
  }, [activeTabId, getActiveWebview]);

  // Ctrl+U：应用内查看网页源代码（新标签页抓取原始 HTML）
  const handleViewSource = useCallback(() => {
    const webview = getActiveWebview();
    if (!webview) return;
    const url = webview.getURL() || '';
    if (!url || /^(about:|sidekickai:|view-source:)/i.test(url)) return;
    const params = new URLSearchParams({ url, profileId });
    newTab(`sidekickai://view-source?${params.toString()}`, { source: 'view-source', kind: 'web' });
  }, [activeTabId, profileId, newTab, getActiveWebview]);

  /* ===== 页面缩放统一动作（快捷键 / 右键菜单 / 浮窗共用，含右上角提示） ===== */
  const applyZoomAction = useCallback((delta: 0.5 | -0.5 | 0) => {
    const webview = getActiveWebview();
    if (!webview) return;
    try {
      const next = delta === 0 ? 0 : Math.max(-4, Math.min(4, webview.getZoomLevel() + delta));
      webview.setZoomLevel(next);
      useZoomStore.getState().show(next);
    } catch { /* ignore */ }
  }, [getActiveWebview]);
  const zoomInAction = useCallback(() => applyZoomAction(0.5), [applyZoomAction]);
  const zoomOutAction = useCallback(() => applyZoomAction(-0.5), [applyZoomAction]);
  const zoomResetAction = useCallback(() => applyZoomAction(0), [applyZoomAction]);

  /** 手动切换手柄/键盘空间导航（Ctrl+G，等效主窗口） */
  const handleToggleSpatialNav = useCallback(() => {
    const webview = getActiveWebview();
    if (!webview) return;
    webview.executeJavaScript(
      'window.__ai_spatial_nav__ && window.__ai_spatial_nav__.toggle(!window.__ai_spatial_nav__.isEnabled())',
    ).catch(() => { /* ignore */ });
  }, [getActiveWebview]);

  // ===== 沉浸式全屏（F11 切换；全屏时隐藏标签/导航/书签栏，仅保留页面与悬浮退出条） =====
  const [isFullscreen, setIsFullscreen] = useState(false);
  // 全屏悬浮退出条的显示状态（鼠标移到顶部时显示，2.5s 后自动隐藏）
  const [fsBarVisible, setFsBarVisible] = useState(false);
  const fsBarTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const off = onFullscreenToggled((fs) => {
      console.log('[fullscreen] onFullscreenToggled IPC received:', fs);
      setIsFullscreen(fs);
      if (!fs) setFsBarVisible(false);
    });
    return () => { off(); };
  }, []);

  const handleToggleFullscreen = useCallback(() => {
    console.log('[fullscreen] handleToggleFullscreen called, isFullscreen=', isFullscreen);
    void toggleFullscreenWindow().then((result) => {
      console.log('[fullscreen] toggleFullscreenWindow IPC returned:', result);
    }).catch((err) => {
      console.error('[fullscreen] toggleFullscreenWindow IPC failed:', err);
    });
  }, [isFullscreen]);

  const handleExitFullscreen = useCallback(() => {
    console.log('[fullscreen] handleExitFullscreen called, isFullscreen=', isFullscreen);
    void exitFullscreenWindow().then((result) => {
      console.log('[fullscreen] exitFullscreenWindow IPC returned:', result);
    }).catch((err) => {
      console.error('[fullscreen] exitFullscreenWindow IPC failed:', err);
    });
    // 联动：如果处于云电脑模式，同时退出
    const cloudPcActive = useCloudPcStore.getState().isActive;
    console.log('[fullscreen] cloudPcActive=', cloudPcActive);
    if (cloudPcActive) {
      void setCloudPcMode(false).then((res) => {
        console.log('[fullscreen] setCloudPcMode(false) returned:', res);
        if (res.ok) useCloudPcStore.getState().setActive(false);
      }).catch((err) => {
        console.error('[fullscreen] setCloudPcMode(false) failed:', err);
      });
    }
  }, [isFullscreen]);

  // 全屏悬浮退出条：进入全屏立即显示一次（告知退出入口）；
  // 之后通过主进程光标坐标轮询探测——webview 覆盖全屏时宿主收不到 mousemove 事件，
  // 光标进入窗口顶部 48px 区域 → 显示；移出后 2.5s 自动隐藏。
  useEffect(() => {
    if (!isFullscreen) return;
    // 进入全屏时立即显示一次，3s 后自动隐藏
    setFsBarVisible(true);
    if (fsBarTimerRef.current) clearTimeout(fsBarTimerRef.current);
    fsBarTimerRef.current = setTimeout(() => setFsBarVisible(false), 3000);

    let disposed = false;
    const timer = setInterval(() => {
      void getCursorPos()
        .then((pos) => {
          if (disposed || !pos.ok) return;
          const inTopBand =
            pos.y >= window.screenY &&
            pos.y <= window.screenY + 48 &&
            pos.x >= window.screenX &&
            pos.x <= window.screenX + window.outerWidth;
          if (inTopBand) {
            setFsBarVisible(true);
            if (fsBarTimerRef.current) clearTimeout(fsBarTimerRef.current);
            fsBarTimerRef.current = setTimeout(() => setFsBarVisible(false), 2500);
          }
        })
        .catch(() => { /* ignore */ });
    }, 150);
    return () => {
      disposed = true;
      clearInterval(timer);
      if (fsBarTimerRef.current) clearTimeout(fsBarTimerRef.current);
    };
  }, [isFullscreen]);

  /* ===== 云电脑模式 ===== */
  const isCloudPc = useCloudPcStore((s) => s.isActive);
  const [cloudPcNotice, setCloudPcNotice] = useState<string | null>(null);
  const cloudPcNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 云电脑模式 + 手柄接入 → 自动开启手柄空间导航（等效主窗口 Ctrl+G）
  useCloudPcGamepadNav({
    containerRef: webviewContainerRef,
    onAutoToggle: (enabled) => {
      if (enabled) {
        setCloudPcNotice('检测到手柄接入，已自动开启手柄操控网页（摇杆/方向键移动 · A 确认 · B 退出）');
      } else {
        setCloudPcNotice(null);
      }
      if (cloudPcNoticeTimerRef.current) clearTimeout(cloudPcNoticeTimerRef.current);
      cloudPcNoticeTimerRef.current = setTimeout(() => setCloudPcNotice(null), 4000);
    },
  });

  // 主进程兜底退出同步（Ctrl+Alt+Shift+F12 / 双击 Esc 触发时渲染层跟随）
  useEffect(() => {
    const off = onCloudPcChanged((active) => {
      useCloudPcStore.getState().setActive(active);
      if (!active) {
        setCloudPcNotice(null);
      }
    });
    return () => { off(); };
  }, []);

  // 云电脑系统级按键路由：主进程捕获 Win/Alt+Tab/Win+Tab/Win+D/Alt+F4 →
  // 合成注入到当前 webview（云电脑网页的 keydown 处理转发远端）。
  // 注入事件 isTrusted=false，但云电脑 Web 客户端普遍只读 keydown/event.code。
  useEffect(() => {
    const off = onCloudPcKeys((e) => {
      const webview = webviewContainerRef.current?.querySelector(
        `webview[data-tab-id="${useBrowserTabStore.getState().activeTabId}"]`,
      ) as (WebviewElement & {
        sendInputEvent: (ev: { type: string; keyCode: string; modifiers?: string[] }) => void;
      }) | null;
      if (!webview) return;
      const send = (type: 'keyDown' | 'keyUp', keyCode: string, modifiers?: string[]) => {
        try { webview.sendInputEvent({ type, keyCode, modifiers }); } catch { /* ignore */ }
      };
      const mods: string[] = [];
      if (e.alt) mods.push('alt');
      if (e.win) mods.push('meta');
      const down = e.down ? 'keyDown' as const : 'keyUp' as const;
      switch (e.key) {
        case 'meta':
          // Win 键：注入 MetaLeft（先左后右的镜像不需要，仅左）
          send(down, e.down ? 'MetaLeft' : 'MetaLeft', e.down ? [] : undefined);
          break;
        case 'tab':
          // Alt+Tab / Win+Tab：注入 修饰键+Tab 组合
          if (e.down) {
            if (e.alt) send('keyDown', 'AltLeft');
            else send('keyDown', 'MetaLeft');
            send('keyDown', 'Tab', mods);
          } else {
            send('keyUp', 'Tab', mods);
            if (e.alt) send('keyUp', 'AltLeft');
            else send('keyUp', 'MetaLeft');
          }
          break;
        case 'd':
          // Win+D：注入 Meta+D
          if (e.down) {
            send('keyDown', 'MetaLeft');
            send('keyDown', 'd', mods);
          } else {
            send('keyUp', 'd', mods);
            send('keyUp', 'MetaLeft');
          }
          break;
        case 'f4':
          // Alt+F4：注入 Alt+F4
          if (e.down) {
            send('keyDown', 'AltLeft');
            send('keyDown', 'F4', mods);
          } else {
            send('keyUp', 'F4', mods);
            send('keyUp', 'AltLeft');
          }
          break;
      }
    });
    return () => { off(); };
  }, [webviewContainerRef]);

  /** 进入/退出云电脑模式（统一入口：设置页开关 / 网站提醒 / 右键菜单 / Ctrl+Alt+C） */
  const toggleCloudPc = useCallback(() => {
    const next = !useCloudPcStore.getState().isActive;
    void setCloudPcMode(next).then((res) => {
      if (!res.ok) {
        // 失败提示（如旧版 preload 未更新）
        setCloudPcNotice(`云电脑模式${next ? '开启' : '退出'}失败：${(res as { error?: string }).error || '请重启应用后重试'}`);
        if (cloudPcNoticeTimerRef.current) clearTimeout(cloudPcNoticeTimerRef.current);
        cloudPcNoticeTimerRef.current = setTimeout(() => setCloudPcNotice(null), 4000);
        return;
      }
      useCloudPcStore.getState().setActive(next);
      if (next) {
        const store = useBrowserTabStore.getState();
        // 当前激活的是内部标签（设置/历史等）时，先切换到网页标签
        // （云电脑模式针对网页内容生效，内部标签没有远端画面）
        const currentTab = store.tabs.find((t) => t.id === store.activeTabId);
        const targetTabId = currentTab && INTERNAL_TAB_SOURCES.includes(currentTab.source)
          ? (store.tabs.find((t) => !INTERNAL_TAB_SOURCES.includes(t.source))?.id ?? currentTab.id)
          : store.activeTabId;
        if (targetTabId && targetTabId !== store.activeTabId) store.switchTab(targetTabId);
        // 重载目标页面：跳过指纹注入（伪造的 screen 尺寸会破坏远端对真实
        // 分辨率/窗口大小的识别）；延迟等 switchTab 生效
        setTimeout(() => {
          const webview = webviewContainerRef.current?.querySelector(
            `webview[data-tab-id="${targetTabId}"]`,
          ) as (WebviewElement & { reload: () => void }) | null;
          webview?.reload();
        }, 60);
        setCloudPcNotice(`云电脑模式已开启 · 报告分辨率 ${window.innerWidth}×${window.innerHeight}`);
        if (cloudPcNoticeTimerRef.current) clearTimeout(cloudPcNoticeTimerRef.current);
        cloudPcNoticeTimerRef.current = setTimeout(() => setCloudPcNotice(null), 4000);
      } else {
        setCloudPcNotice(null);
      }
    }).catch((err) => {
      console.error('[cloud-pc] toggle 失败:', err);
      setCloudPcNotice(`云电脑模式切换失败：${String(err)}`);
      if (cloudPcNoticeTimerRef.current) clearTimeout(cloudPcNoticeTimerRef.current);
      cloudPcNoticeTimerRef.current = setTimeout(() => setCloudPcNotice(null), 4000);
    });
  }, [activeTabId, webviewContainerRef]);

  // 云电脑/云游戏网站检测提醒（BrowserWebviewTab 导航时派发 cloud-pc-suggest）
  const [cloudPcSuggestion, setCloudPcSuggestion] = useState<{ url: string; siteName: string } | null>(null);
  const ignoredCloudPcHosts = useRef<Set<string>>(new Set());

  useEffect(() => {
    const onSuggest = (e: Event) => {
      const detail = (e as CustomEvent).detail as { url: string; siteName: string } | undefined;
      if (!detail?.url) return;
      if (useCloudPcStore.getState().isActive) return;
      try {
        const host = new URL(detail.url).hostname;
        if (ignoredCloudPcHosts.current.has(host)) return;
      } catch { return; }
      setCloudPcSuggestion(detail);
    };
    // 设置页开关：BrowserSettingsTab dispatch 的统一入口
    const onToggle = () => toggleCloudPc();
    window.addEventListener('cloud-pc-suggest', onSuggest);
    window.addEventListener('cloud-pc-toggle', onToggle);
    return () => {
      window.removeEventListener('cloud-pc-suggest', onSuggest);
      window.removeEventListener('cloud-pc-toggle', onToggle);
    };
  }, [toggleCloudPc]);

  const dismissCloudPcSuggestion = useCallback(() => {
    if (cloudPcSuggestion) {
      try { ignoredCloudPcHosts.current.add(new URL(cloudPcSuggestion.url).hostname); } catch { /* ignore */ }
    }
    setCloudPcSuggestion(null);
  }, [cloudPcSuggestion]);

  /** 接受云电脑建议：清除提醒并进入云电脑模式（不加入忽略名单） */
  const acceptCloudPcSuggestion = useCallback(() => {
    setCloudPcSuggestion(null);
    toggleCloudPc();
  }, [toggleCloudPc]);

  // 云电脑内容缩放（4K 屏跑 1080P 云电脑自动放大铺满，防移动端误判）
  const { applyZoom } = useCloudPcZoom(webviewContainerRef, activeTabId);
  const cloudPcZoomFactor = useCloudPcStore((s) => s.zoomFactor);
  const cloudPcZoomMode = useCloudPcStore((s) => s.zoomMode);
  const cloudPcRemoteRes = useCloudPcStore((s) => s.remoteResolution);

  const setManualZoom = useCallback((factor: number) => {
    applyZoom(factor, 'manual');
  }, [applyZoom]);

  const resetAutoZoom = useCallback(() => {
    // 回到自动模式：重置为 1；hook 的 zoomMode effect 会立即触发远端分辨率检测
    applyZoom(1, 'auto');
  }, [applyZoom]);

  /** Alt+P：冻结/恢复当前页面（防撤回保险） */
  const handleToggleFreeze = useCallback((requestedTabId?: string) => {
    const targetTabId = requestedTabId && useBrowserTabStore.getState().tabs.some((tab) => tab.id === requestedTabId)
      ? requestedTabId
      : activeTabId;
    if (!targetTabId || !profileId) {
      console.warn('[BrowserView] 冻结跳过：tabId 或 profileId 为空', { targetTabId, profileId });
      return;
    }
    console.log('[BrowserView] Alt+P 请求主进程切换冻结状态, tabId', targetTabId);
    void useFreezeStore.getState().doToggle(targetTabId, profileId);
  }, [activeTabId, profileId]);

  /* ===== 手柄接入（Gamepad API，宿主采集 + 状态 UI + guest 桥接） ===== */
  // 采集器在宿主渲染层运行：连接状态写 store（导航栏指示器），
  // 实时帧除回调外桥接到当前激活 webview 的 window.__sidekickGamepadState，
  // 供云游戏页面在自身 Gamepad API 不可用时读取（标准场景页面直接使用原生 API，
  // 主进程已关闭 RestrictGamepadAccess 限制）。
  const gamepadBridgeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const store = useGamepadStore.getState();
    const collector = new GamepadCollector({
      rate: 60,
      onFrame: (frame) => {
        store.setFrame(frame, '');
      },
      onConnectionChange: (connections) => {
        store.setConnections(connections);
      },
    });
    collector.start();

    // guest 桥接：手柄连接时以 30Hz 把最新帧写入当前 webview 的全局状态
    gamepadBridgeTimerRef.current = setInterval(() => {
      const { connectedCount, pads } = useGamepadStore.getState();
      if (connectedCount === 0) return;
      const activeId = useBrowserTabStore.getState().activeTabId;
      const webview = webviewContainerRef.current?.querySelector(
        `webview[data-tab-id="${activeId}"]`,
      ) as (WebviewElement & { executeJavaScript: (s: string) => Promise<unknown> }) | null;
      if (!webview) return;
      const state = {
        connected: connectedCount > 0,
        pads: Object.values(pads).filter((p) => p.connected).map((p) => ({
          index: p.index,
          id: p.id,
          buttons: p.frame?.buttons ?? 0,
          axes: p.frame?.axes ?? [0, 0, 0, 0],
          triggers: p.frame?.triggers ?? [0, 0],
          dpad: p.frame?.dpad ?? 0,
        })),
      };
      void webview.executeJavaScript(`window.__sidekickGamepadState = ${JSON.stringify(state)};`).catch(() => { /* ignore */ });
    }, 33);

    return () => {
      collector.stop();
      if (gamepadBridgeTimerRef.current) {
        clearInterval(gamepadBridgeTimerRef.current);
        gamepadBridgeTimerRef.current = null;
      }
      useGamepadStore.getState().reset();
    };
  }, [webviewContainerRef]);

  return {
    handleGoBack,
    handleGoForward,
    handleRefresh,
    handleStopLoading,
    handleForceRefresh,
    handleFocusCycle,
    focusCycleRef,
    handleAddBookmark,
    handleFocusSearch,
    handleFindInPage,
    handlePrint,
    handleToggleDevTools,
    handleSavePageAs,
    handleViewSource,
    zoomInAction,
    zoomOutAction,
    zoomResetAction,
    handleToggleSpatialNav,
    isFullscreen,
    fsBarVisible,
    handleToggleFullscreen,
    handleExitFullscreen,
    isCloudPc,
    cloudPcNotice,
    toggleCloudPc,
    cloudPcSuggestion,
    dismissCloudPcSuggestion,
    acceptCloudPcSuggestion,
    setManualZoom,
    resetAutoZoom,
    cloudPcZoomMode,
    cloudPcZoomFactor,
    cloudPcRemoteRes,
    handleToggleFreeze,
  };
}
