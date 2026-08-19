/* =====================================================================
   pages/BrowserView/ViewSourceTab.tsx —— 查看网页源代码标签页（资源浏览器）
   深度结合 F12 开发者环境的设计：
   - 使用对应 partition 的 session.fetch 抓取原始 HTML（携带登录态 Cookie）
   - 顶部 URL 输入框：可切换定位任意其他网页文件查看其源码
   - 解析源码中的 src/href 资源引用（图片/脚本/样式/链接）为可点击 chips：
     图片等媒体 → 引用外部地址在系统浏览器打开；
     其它资源（js/css/html）→ 在本标签继续查看该资源源码
   - 「关闭标签」按钮正常退出；侧边显示资源数量
   ===================================================================== */

import { useCallback, useEffect, useState } from 'react';
import type { BrowserTabState, Profile } from '../../lib/electron-api';
import { viewSource, openExternal } from '../../lib/electron-api';
import { useBrowserTabStore } from '../../store/useBrowserTabStore';

interface ViewSourceTabProps {
  tab: BrowserTabState;
  profile: Profile;
}

/** 解析 sidekickai://view-source?url=...&profileId=... 参数 */
function parseParams(tabUrl: string): { url: string; profileId: string } {
  try {
    const u = new URL(tabUrl);
    return {
      url: u.searchParams.get('url') || '',
      profileId: u.searchParams.get('profileId') || '',
    };
  } catch {
    return { url: '', profileId: '' };
  }
}

/** 媒体类资源（图片/音视频/字体/PDF）——引用外部地址直接打开 */
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif|mp4|webm|mp3|wav|ogg|pdf|woff2?|ttf|otf)([?#].*)?$/i;

/** 从源码提取绝对资源 URL（去重，限制 http/https，排除 data/锚点/脚本协议） */
function extractResources(html: string, baseUrl: string): string[] {
  if (!baseUrl) return [];
  const urls: string[] = [];
  const seen = new Set<string>();
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1] || '';
    if (!raw || raw.startsWith('data:') || raw.startsWith('#') || raw.startsWith('javascript:')) continue;
    try {
      const abs = new URL(raw, baseUrl).href;
      if (/^https?:/i.test(abs) && !seen.has(abs)) {
        seen.add(abs);
        urls.push(abs);
      }
    } catch { /* ignore */ }
  }
  return urls;
}

export default function ViewSourceTab({ tab, profile }: ViewSourceTabProps) {
  const { url: initialUrl, profileId } = parseParams(tab.url);
  const partition = 'persist:' + (profileId || profile.id);
  const [viewingUrl, setViewingUrl] = useState(initialUrl);
  const [urlDraft, setUrlDraft] = useState(initialUrl);
  const [loading, setLoading] = useState(true);
  const [html, setHtml] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [resources, setResources] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  // 非交互刷新触发（导航栏刷新按钮 / 标签右键刷新）
  const [refreshTick, setRefreshTick] = useState(0);

  // 地址栏（tab.url 外部变化）驱动查看目标：navigateTab 后同步解析并加载
  useEffect(() => {
    const { url: newUrl } = parseParams(tab.url);
    if (newUrl && newUrl !== viewingUrl) {
      setViewingUrl(newUrl);
      setUrlDraft(newUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.url]);

  // 刷新事件：导航栏刷新按钮 / 标签右键菜单（内部标签无 webview，用事件驱动）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.tabId === tab.id) setRefreshTick((t) => t + 1);
    };
    window.addEventListener('browser-tab-reload', handler);
    return () => window.removeEventListener('browser-tab-reload', handler);
  }, [tab.id]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void viewSource(partition, viewingUrl).then((res) => {
      if (cancelled) return;
      if (res.ok && res.html !== undefined) {
        setHtml(res.html);
        setResources(extractResources(res.html, viewingUrl));
      } else {
        setError(res.error || '无法获取网页源代码');
      }
      setLoading(false);
    }).catch((e) => {
      if (cancelled) return;
      setError(String(e));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [partition, viewingUrl, refreshTick]);

  const handleGo = useCallback(() => {
    const trimmed = urlDraft.trim();
    if (!trimmed) return;
    setViewingUrl(trimmed);
  }, [urlDraft]);

  const handleCopyAll = useCallback(() => {
    if (!html) return;
    void navigator.clipboard.writeText(html).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* ignore */ });
  }, [html]);

  /** 打开资源：媒体 → 外部浏览器；其它 → 本标签继续查看源码并同步地址栏 */
  const handleOpenResource = useCallback((url: string) => {
    try {
      const pathname = new URL(url).pathname;
      if (MEDIA_EXT.test(pathname)) {
        void openExternal(url);
        return;
      }
    } catch { /* ignore */ }
    // 更新标签 URL（地址栏显示当前查看的资源地址，支持前进/后退语义统一）
    const nextTabUrl = 'sidekickai://view-source?url=' + encodeURIComponent(url) + '&profileId=' + (profileId || profile.id);
    useBrowserTabStore.getState().navigateTab(tab.id, nextTabUrl);
    setUrlDraft(url);
    setViewingUrl(url);
  }, [tab.id, profileId, profile.id]);

  const handleCloseTab = useCallback(() => {
    void useBrowserTabStore.getState().closeTab(tab.id);
  }, [tab.id]);

  return (
    <div className="view-source-tab" data-name="browser.view-source-tab">
      <div className="view-source-header" data-name="browser.view-source-header">
        <input
          type="text"
          className="view-source-url-input"
          value={urlDraft}
          onChange={(e) => setUrlDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleGo(); }}
          placeholder="输入任意网页地址查看其源码（可切换定位其他文件）"
          data-name="browser.view-source-url-input"
        />
        <button type="button" className="view-source-copy" onClick={handleGo} data-name="browser.view-source-go">
          查看
        </button>
        <button type="button" className="view-source-copy" onClick={handleCopyAll} disabled={!html} data-name="browser.view-source-copy">
          {copied ? '已复制' : '复制全部'}
        </button>
        <button type="button" className="view-source-copy" onClick={handleCloseTab} data-name="browser.view-source-close">
          关闭标签
        </button>
      </div>
      {/* 资源 chips 条：常驻（无资源时显示空态），不限制数量，超高滚动 */}
      <div className="view-source-resources" data-name="browser.view-source-resources">
        <span className="view-source-resources-label">资源（{resources.length}）：</span>
        {resources.length === 0 ? (
          <span className="view-source-resources-empty">无外部资源引用</span>
        ) : (
          resources.map((url) => (
            <button
              key={url}
              type="button"
              className="view-source-resource-chip"
              title={url}
              onClick={() => handleOpenResource(url)}
              data-name="browser.view-source-resource"
            >
              {(() => {
                try { return new URL(url).hostname + new URL(url).pathname.slice(-24); }
                catch { return url.slice(-32); }
              })()}
            </button>
          ))
        )}
      </div>
      {loading ? (
        <div className="view-source-loading" data-name="browser.view-source-loading">正在获取网页源代码...</div>
      ) : error ? (
        <div className="view-source-error" data-name="browser.view-source-error">
          获取源代码失败：{error}
          <div className="view-source-error-hint">
            提示：部分页面（如需要登录后可见的内容）可能无法抓取，可在页面右键选择「另存为」保存完整页面。
          </div>
        </div>
      ) : (
        <pre className="view-source-code" data-name="browser.view-source-code">{html}</pre>
      )}
    </div>
  );
}
