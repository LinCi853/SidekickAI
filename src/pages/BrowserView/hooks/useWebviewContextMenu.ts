/* =====================================================================
   pages/BrowserView/hooks/useWebviewContextMenu.ts —— 右键菜单逻辑
   抽取自 BrowserWebviewTab.tsx：context-menu 事件处理 + 全部菜单操作回调
   （后退/前进/重载/另存为/打印/源码/检查/截图/缩放/云电脑/链接/图片/输入框）。
   ===================================================================== */

import { useCallback, useEffect, useState } from 'react';
import type { BrowserTabState, Profile } from '../../../lib/electron-api';
import {
  downloadAs,
  printPreview,
  saveCapture,
  savePageAs,
} from '../../../lib/electron-api';
import type { WebviewContextMenuParams, WebviewElement } from '../../../lib/webview.js';
import { useBrowserTabStore } from '../../../store/useBrowserTabStore.js';
import { useFreezeStore } from '../../../store/useFreezeStore.js';
import type { WebviewContextType, WebviewEditFlags } from '../WebviewContextMenu.js';
import { deriveSaveName } from '../utils/derive-save-name.js';
import {
  READ_CONTEXT_COORD_SCRIPT,
  buildCopyImageToDataUrlScript,
  buildExecCommandScript,
  buildFocusEditableAtScript,
} from '../webview-scripts.js';

/** 右键菜单状态（v0.0.9+：由 context-menu 事件的标准 params 驱动） */
export interface WebviewContextMenuState {
  /** 菜单在浏览器窗口中的定位（菜单弹出位置） */
  position: { x: number; y: number };
  /** guest 页面内的坐标（elementFromPoint 等页面内操作使用） */
  guestPos: { x: number; y: number };
  contextType: WebviewContextType;
  linkUrl?: string;
  imageUrl?: string;
  /** 右键所在页面的 URL（查看源码用，比 getURL() 更准） */
  pageUrl?: string;
  /** 保存链接/图片时建议的文件名 */
  suggestedFilename?: string;
  selectedText?: string;
  /** 输入框编辑能力标志（决定撤销/重做/剪切/复制/粘贴/全选禁用状态） */
  editFlags?: WebviewEditFlags;
}

export interface UseWebviewContextMenuParams {
  webviewRef: React.MutableRefObject<WebviewElement | null>;
  tab: BrowserTabState;
  profile: Profile;
  /** 导航回调（后退/前进/重新加载） */
  onGoBack?: () => void;
  onGoForward?: () => void;
  onReload?: () => void;
  /** 页面缩放（统一走 BrowserView 缩放动作含右上角提示） */
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomReset?: () => void;
}

export function useWebviewContextMenu({
  webviewRef,
  tab,
  profile,
  onGoBack,
  onGoForward,
  onReload,
  onZoomIn,
  onZoomOut,
  onZoomReset,
}: UseWebviewContextMenuParams) {
  const [contextMenu, setContextMenu] = useState<WebviewContextMenuState | null>(null);

  // ===== 右键菜单处理 =====
  // 现代浏览器标准：直接消费 webview context-menu 事件的标准 params（ContextMenuParams）。
  // 该参数包含右键位置（x/y）、目标类型（isEditable / linkURL / srcURL / mediaType）、
  // 选中文本（selectionText）与编辑能力标志（editFlags），比 elementFromPoint 猜测
  // 更可靠，且能正确处理 iframe、shadow DOM 与页面自定义右键菜单的场景。

  // 处理右键菜单事件
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const handleContextMenu = async (e: Event) => {
      const params = (e as unknown as { params?: Partial<WebviewContextMenuParams> }).params;
      if (!params) return;

      // 优先读 guest 注入的精确坐标（contextmenu DOM 事件的 clientX/clientY，
      // 与 elementFromPoint / inspectElement 使用同一坐标系），回退 params
      let guestX = params.x || 0;
      let guestY = params.y || 0;
      try {
        const ctx = await webview.executeJavaScript(READ_CONTEXT_COORD_SCRIPT) as { x: number; y: number; isEditable: boolean } | null;
        if (ctx && typeof ctx.x === 'number' && typeof ctx.y === 'number') {
          guestX = ctx.x;
          guestY = ctx.y;
        }
      } catch { /* ignore */ }

      // guest 页面 viewport 坐标 → 浏览器窗口坐标（考虑页面缩放因子）
      let zoom = 1;
      try { zoom = webview.getZoomFactor?.() ?? 1; } catch { /* ignore */ }
      const rect = webview.getBoundingClientRect();
      const x = rect.left + guestX * zoom;
      const y = rect.top + guestY * zoom;

      // 上下文类型判定（优先级：输入框 > 链接 > 图片 > 页面）
      let contextType: WebviewContextType = 'page';
      if (params.isEditable) contextType = 'input';
      else if (params.linkURL) contextType = 'link';
      else if (params.mediaType === 'image' && params.srcURL) contextType = 'image';

      setContextMenu({
        position: { x, y },
        guestPos: { x: guestX, y: guestY },
        contextType,
        linkUrl: params.linkURL || undefined,
        imageUrl: params.mediaType === 'image' && params.srcURL ? params.srcURL : undefined,
        pageUrl: params.pageURL || undefined,
        suggestedFilename: params.suggestedFilename || undefined,
        selectedText: params.selectionText || undefined,
        editFlags: params.editFlags as WebviewEditFlags | undefined,
      });
    };

    webview.addEventListener('context-menu', handleContextMenu as EventListener);

    return () => {
      webview.removeEventListener('context-menu', handleContextMenu as EventListener);
    };
  }, []);

  // 关闭右键菜单
  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // 右键菜单操作回调
  const handleContextMenuGoBack = useCallback(() => {
    if (onGoBack) {
      onGoBack();
    } else {
      const webview = webviewRef.current;
      if (webview?.canGoBack()) webview.goBack();
    }
  }, [onGoBack]);

  const handleContextMenuGoForward = useCallback(() => {
    if (onGoForward) {
      onGoForward();
    } else {
      const webview = webviewRef.current;
      if (webview?.canGoForward()) webview.goForward();
    }
  }, [onGoForward]);

  const handleContextMenuReload = useCallback(() => {
    if (onReload) {
      onReload();
    } else {
      webviewRef.current?.reload();
    }
  }, [onReload]);

  // 另存为：保存当前页面（主进程弹保存对话框，HTMLComplete 格式）
  const handleContextMenuSaveAs = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    let wcId: number | null = null;
    try { wcId = webview.getWebContentsId(); } catch { /* webview 未 attach */ }
    if (wcId === null) return;
    const url = webview.getURL() || '';
    void savePageAs(wcId, deriveSaveName(url, tab.title)).catch(() => { /* ignore */ });
  }, [tab.title]);

  // 打印：在应用内生成打印预览（新标签页展示 PDF，可打印/另存为）
  const handleContextMenuPrint = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    let wcId: number | null = null;
    try { wcId = webview.getWebContentsId(); } catch { /* webview 未 attach */ }
    if (wcId === null) return;
    const url = webview.getURL() || '';
    void printPreview(wcId, deriveSaveName(url, tab.title)).then((res) => {
      if (res.ok && res.filePath) {
        const store = useBrowserTabStore.getState();
        const params = new URLSearchParams({
          file: res.filePath,
          title: res.title || tab.title || '页面',
          sourceUrl: url,
        });
        store.newTab(`sidekickai://print-preview?${params.toString()}`, { source: 'print-preview', kind: 'web' });
      }
    }).catch(() => { /* ignore */ });
  }, [tab.title]);

  // 查看网页源代码：应用内新标签页抓取原始 HTML 展示（现代浏览器 Ctrl+U 行为）
  const handleContextMenuViewSource = useCallback(() => {
    let url = contextMenu?.pageUrl || '';
    if (!url) {
      try { url = webviewRef.current?.getURL() || ''; } catch { /* ignore */ }
    }
    if (!url || /^(about:|sidekickai:|view-source:)/i.test(url)) return;
    const store = useBrowserTabStore.getState();
    const params = new URLSearchParams({ url, profileId: profile.id });
    store.newTab(`sidekickai://view-source?${params.toString()}`, { source: 'view-source', kind: 'web' });
  }, [contextMenu?.pageUrl, profile.id]);

  // 检查（DevTools）：打开控制台并直接定位到右键位置的具体元素
  const handleContextMenuInspect = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    if (useFreezeStore.getState().states[tab.id] === 'frozen') return;
    try {
      if (!webview.isDevToolsOpened()) {
        webview.openDevTools();
        // DevTools 首次打开需要加载，稍后定位确保生效
        const { x, y } = contextMenu?.guestPos ?? { x: 0, y: 0 };
        setTimeout(() => {
          try { webview.inspectElement(x, y); } catch { /* ignore */ }
        }, 250);
      } else if (contextMenu?.guestPos) {
        webview.inspectElement(contextMenu.guestPos.x, contextMenu.guestPos.y);
      }
    } catch { /* ignore */ }
  }, [tab.id, contextMenu?.guestPos]);

  const handleContextMenuOpenLink = useCallback(() => {
    if (contextMenu?.linkUrl) {
      const store = useBrowserTabStore.getState();
      store.newTab(contextMenu.linkUrl, { kind: 'web' });
    }
  }, [contextMenu?.linkUrl]);

  const handleContextMenuCopyLink = useCallback(() => {
    if (contextMenu?.linkUrl) {
      void navigator.clipboard.writeText(contextMenu.linkUrl);
    }
  }, [contextMenu?.linkUrl]);

  // 链接/图片另存为：经主进程下载到用户指定路径（will-download 弹保存对话框）
  // partition 与 webview 的 session 一致（persist:profile.id），主进程据此定位下载记录
  const downloadUrlAs = useCallback((url: string, suggestedFilename?: string) => {
    if (!url) return;
    const partition = `persist:${profile.id}`;
    void downloadAs(partition, url, suggestedFilename).catch(() => { /* ignore */ });
  }, [profile.id]);

  const handleContextMenuSaveLinkAs = useCallback(() => {
    if (contextMenu?.linkUrl) {
      downloadUrlAs(contextMenu.linkUrl, contextMenu.suggestedFilename);
    }
  }, [contextMenu?.linkUrl, contextMenu?.suggestedFilename, downloadUrlAs]);

  const handleContextMenuSaveImage = useCallback(() => {
    if (contextMenu?.imageUrl) {
      // 从图片 URL 推导默认文件名（如 /path/photo.jpg → photo.jpg）
      let name = '';
      try {
        name = decodeURIComponent(new URL(contextMenu.imageUrl).pathname.split('/').pop() || '');
      } catch { /* ignore */ }
      downloadUrlAs(contextMenu.imageUrl, name || contextMenu.suggestedFilename);
    }
  }, [contextMenu?.imageUrl, contextMenu?.suggestedFilename, downloadUrlAs]);

  // 复制图片：优先将真实图片写入剪贴板（跨域/加载失败时回退为复制图片地址）
  const handleContextMenuCopyImage = useCallback(() => {
    const webview = webviewRef.current;
    const imageUrl = contextMenu?.imageUrl;
    if (!webview || !imageUrl) return;
    const fallback = () => { void navigator.clipboard.writeText(imageUrl); };
    void webview.executeJavaScript(buildCopyImageToDataUrlScript(JSON.stringify(imageUrl))).then(async (dataUrl) => {
      if (dataUrl && typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) {
        try {
          const blob = await (await fetch(dataUrl)).blob();
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          return;
        } catch { /* 写入失败回退复制地址 */ }
      }
      fallback();
    }).catch(fallback);
  }, [contextMenu?.imageUrl]);

  const handleContextMenuCopyImageUrl = useCallback(() => {
    if (contextMenu?.imageUrl) {
      void navigator.clipboard.writeText(contextMenu.imageUrl);
    }
  }, [contextMenu?.imageUrl]);

  // 复制页面选中文本
  const handleContextMenuCopySelection = useCallback(() => {
    if (contextMenu?.selectedText) {
      void navigator.clipboard.writeText(contextMenu.selectedText);
    }
  }, [contextMenu?.selectedText]);

  // 在 guest 页面内聚焦右键位置的输入元素（输入框编辑操作前置步骤；
  // 右键点击不会自动聚焦输入框，直接 execCommand 会因无焦点而失效）
  const focusEditableAt = useCallback((x: number, y: number) => {
    const webview = webviewRef.current;
    if (!webview) return Promise.resolve(false);
    return webview.executeJavaScript(buildFocusEditableAtScript(x, y)).then(() => true).catch(() => false);
  }, []);

  // 输入框编辑命令（撤销/重做/剪切/复制/全选）
  const runInputEditCommand = useCallback((cmd: 'undo' | 'redo' | 'cut' | 'copy' | 'selectAll') => {
    const webview = webviewRef.current;
    if (!webview || !contextMenu || contextMenu.contextType !== 'input') return;
    const { guestPos } = contextMenu;
    void focusEditableAt(guestPos.x, guestPos.y).then((focused) => {
      if (!focused) return;
      webview.executeJavaScript(buildExecCommandScript(cmd)).catch(() => { /* ignore */ });
    });
  }, [contextMenu, focusEditableAt]);

  const handleContextMenuUndo = useCallback(() => runInputEditCommand('undo'), [runInputEditCommand]);
  const handleContextMenuRedo = useCallback(() => runInputEditCommand('redo'), [runInputEditCommand]);
  const handleContextMenuCut = useCallback(() => runInputEditCommand('cut'), [runInputEditCommand]);
  const handleContextMenuCopy = useCallback(() => runInputEditCommand('copy'), [runInputEditCommand]);
  const handleContextMenuSelectAll = useCallback(() => runInputEditCommand('selectAll'), [runInputEditCommand]);

  // 粘贴：聚焦右键输入元素后执行 guest 原生粘贴命令（webview.paste），
  // 粘贴为纯文本：pasteAndMatchStyle（去格式粘贴，与 Chrome 行为一致）
  const pasteIntoEditable = useCallback((matchStyle: boolean) => {
    const webview = webviewRef.current;
    if (!webview || !contextMenu || contextMenu.contextType !== 'input') return;
    const { guestPos } = contextMenu;
    void focusEditableAt(guestPos.x, guestPos.y).then((focused) => {
      if (!focused) return;
      // 焦点生效后执行 guest 原生粘贴命令（微延迟保证聚焦完成）
      setTimeout(() => {
        try {
          if (matchStyle) {
            webview.pasteAndMatchStyle();
          } else {
            webview.paste();
          }
        } catch { /* ignore */ }
      }, 30);
    });
  }, [contextMenu, focusEditableAt]);

  const handleContextMenuPaste = useCallback(() => pasteIntoEditable(false), [pasteIntoEditable]);
  const handleContextMenuPasteAsPlainText = useCallback(() => pasteIntoEditable(true), [pasteIntoEditable]);

  // 截图当前页面：capturePage → 保存对话框写入 PNG
  const handleContextMenuScreenshot = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    void webview.capturePage().then((image) => {
      const dataUrl = image.toDataURL();
      const url = (() => { try { return webview.getURL() || ''; } catch { return ''; } })();
      void saveCapture(dataUrl, deriveSaveName(url, tab.title) + '-截图');
    }).catch(() => { /* ignore */ });
  }, [tab.title]);

  // 页面缩放（现代浏览器标准：Ctrl+= / Ctrl+- / Ctrl+0，右键菜单可调）。
  // 优先走 BrowserView 统一动作（含右上角缩放浮窗提示）；无 props 时降级本地实现。
  const zoomLocal = useCallback((delta: 0.5 | -0.5 | 0) => {
    const webview = webviewRef.current;
    if (!webview) return;
    try {
      const next = delta === 0 ? 0 : Math.max(-4, Math.min(4, webview.getZoomLevel() + delta));
      webview.setZoomLevel(next);
    } catch { /* ignore */ }
  }, []);

  const handleZoomIn = useCallback(() => {
    if (onZoomIn) { onZoomIn(); return; }
    zoomLocal(0.5);
  }, [onZoomIn, zoomLocal]);

  const handleZoomOut = useCallback(() => {
    if (onZoomOut) { onZoomOut(); return; }
    zoomLocal(-0.5);
  }, [onZoomOut, zoomLocal]);

  const handleZoomReset = useCallback(() => {
    if (onZoomReset) { onZoomReset(); return; }
    zoomLocal(0);
  }, [onZoomReset, zoomLocal]);

  return {
    contextMenu,
    handleCloseContextMenu,
    handleContextMenuGoBack,
    handleContextMenuGoForward,
    handleContextMenuReload,
    handleContextMenuSaveAs,
    handleContextMenuPrint,
    handleContextMenuViewSource,
    handleContextMenuInspect,
    handleContextMenuScreenshot,
    handleZoomIn,
    handleZoomOut,
    handleZoomReset,
    handleContextMenuCopySelection,
    handleContextMenuOpenLink,
    handleContextMenuCopyLink,
    handleContextMenuSaveLinkAs,
    handleContextMenuSaveImage,
    handleContextMenuCopyImage,
    handleContextMenuCopyImageUrl,
    handleContextMenuUndo,
    handleContextMenuRedo,
    handleContextMenuCut,
    handleContextMenuCopy,
    handleContextMenuPaste,
    handleContextMenuPasteAsPlainText,
    handleContextMenuSelectAll,
  };
}
