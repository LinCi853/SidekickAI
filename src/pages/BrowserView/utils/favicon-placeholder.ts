/* =====================================================================
   pages/BrowserView/utils/favicon-placeholder.ts —— favicon 占位图标生成
   当网站无 favicon 时，生成域名首字母 + 主题色背景的占位图标。
   ===================================================================== */

/**
 * 从 URL 提取域名首字母（大写）。
 * 例如 "https://www.example.com/page" → "E"
 */
export function extractDomainInitial(url: string): string {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    // 去除 www. 前缀
    const clean = hostname.replace(/^www\./, '');
    // 取最后一个域名段的首字母（如 example.com → e）
    const parts = clean.split('.');
    const domain = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    if (!domain) return '?';
    return domain.charAt(0).toUpperCase();
  } catch {
    return '?';
  }
}

/**
 * 生成 SVG 占位图标的 data URL。
 *
 * @param initial 首字母（大写）
 * @param bgColor 背景色（CSS 颜色值）
 * @returns SVG data URL
 */
export function generatePlaceholderSvg(initial: string, bgColor: string): string {
  const safeInitial = initial || '?';
  const safeBg = bgColor || '#888888';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="${safeBg}"/><text x="16" y="22" font-family="Arial, sans-serif" font-size="16" font-weight="bold" fill="white" text-anchor="middle">${safeInitial}</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/**
 * 从 webview 中提取网站主题色（meta[name="theme-color"]）。
 * 需在 dom-ready 后调用。
 *
 * @param webview webview 元素
 * @returns 主题色字符串（如 "#4285f4"），提取失败返回空字符串
 */
export async function extractThemeColor(
  webview: { executeJavaScript: (code: string) => Promise<unknown> },
): Promise<string> {
  try {
    const result = await webview.executeJavaScript(`
      (function() {
        var meta = document.querySelector('meta[name="theme-color"]');
        if (meta && meta.content) return meta.content;
        // 回退：尝试 apple-mobile-web-app-status-bar-style
        meta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
        if (meta && meta.content) return meta.content;
        return '';
      })()
    `);
    if (typeof result === 'string' && result.length > 0) {
      return result;
    }
    return '';
  } catch {
    return '';
  }
}
