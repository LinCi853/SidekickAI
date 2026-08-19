/* =====================================================================
   pages/BrowserView/constants.ts —— 浏览器窗口共享常量、工具与类型
   ===================================================================== */

/** 内部标签来源（无独立 webview 的标签页） */
export const INTERNAL_TAB_SOURCES: readonly string[] = [
  'settings',
  'bookmark-manager',
  'history',
  'downloads',
  'view-source',
  'print-preview',
];

/** 从 URL 查询参数获取值 */
export function getQueryParam(key: string): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get(key);
}

export interface WebviewElement {
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  reloadIgnoringCache(): void;
  stop(): void;
  isDevToolsOpened(): boolean;
  openDevTools(): void;
  closeDevTools(): void;
  getURL(): string;
  getTitle(): string;
  getWebContentsId(): number;
  executeJavaScript(script: string): Promise<unknown>;
  print(): void;
  /** 页面缩放级别（log2 尺度） */
  getZoomLevel(): number;
  setZoomLevel(level: number): void;
}
