/* =====================================================================
   pages/BrowserView/utils/derive-save-name.ts —— 「另存为」默认文件名推导
   从页面 URL/标题推导合法的文件名（清理非法字符）。
   ===================================================================== */

/**
 * 从页面 URL/标题推导「另存为」默认文件名（清理非法字符）。
 * 优先使用清理后的标题；标题为空时回退到 URL pathname 末段或 hostname。
 *
 * @param url 页面 URL（标题为空时的回退来源）
 * @param title 页面标题（优先来源）
 * @returns 清理后的文件名（最长 80 字符）
 */
export function deriveSaveName(url: string, title?: string): string {
  const cleaned = (title || '').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  if (cleaned) return cleaned;
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (last) return decodeURIComponent(last).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'page';
    return u.hostname.replace(/^www\./, '') || 'page';
  } catch {
    return 'page';
  }
}
