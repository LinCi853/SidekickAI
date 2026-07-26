/* =====================================================================
   lib/webview.ts —— webview 公共类型与注入工具
   抽取自 MainView.tsx / StandaloneView.tsx 中重复的 WebviewElement 接口定义
   与 viewport + window.open 拦截脚本，保持注入内容与原实现逐字一致。
   ===================================================================== */

/** 复用 React 内置 HTMLWebViewElement，并显式声明本组件使用的方法（兼容不同 @types/react 版本） */
export interface WebviewElement extends HTMLWebViewElement {
  /** 设置 src 属性触发导航（DOM 属性变化，不经过 GUEST_VIEW_MANAGER_CALL IPC，可用于 guest 进程崩溃后恢复） */
  src: string;
  executeJavaScript(script: string): Promise<unknown>;
  reload(): void;
  loadURL(url: string): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  setUserAgent(ua: string): void;
  /** 获取当前页面 URL */
  getURL(): string;
  /** 获取 guest webContents id（webview attach 后可用；未 attach 时调用会抛错） */
  getWebContentsId(): number;
  /** 截图当前页面（需求 12：截图到白板）。返回 NativeImage，调用 toDataURL() 转 base64 */
  capturePage(): Promise<{ toDataURL(): string; toPNG(): Buffer }>;
  addEventListener(event: string, callback: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(event: string, callback: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
}

/**
 * 清理 URL：去除首尾的反引号、单引号、空白等无效字符。
 * Electron 错误消息格式化会用反引号包裹 URL（如 `` '`https://...'` ``），
 * 如果错误消息被误传回 loadURL，会导致 ERR_FAILED。
 * 此函数在所有 loadURL/src 入口前做防御性清理。
 */
export function sanitizeUrl(url: string): string {
  if (!url) return '';
  let cleaned = url.trim();
  // 循环去除首尾的反引号和单引号（可能成对出现多次）
  let changed = true;
  while (changed) {
    changed = false;
    if (cleaned.startsWith('`')) { cleaned = cleaned.slice(1); changed = true; }
    if (cleaned.endsWith('`')) { cleaned = cleaned.slice(0, -1); changed = true; }
    if (cleaned.startsWith("'")) { cleaned = cleaned.slice(1); changed = true; }
    if (cleaned.endsWith("'")) { cleaned = cleaned.slice(0, -1); changed = true; }
  }
  return cleaned.trim();
}

/**
 * 安全刷新 webview：
 * - domReady=true（正常状态）：调用 reload()，保留页面状态（滚动位置等）
 * - domReady=false（guest 进程崩溃/未就绪）：调用 loadURL(fallbackUrl) 重新触发 guest 进程
 * - loadURL 也失败时（guest 进程完全死亡）：派发 'ai-webview-fatal-failure' DOM 事件，
 *   通知 WebviewTab 销毁并重建 <webview> 元素
 *
 * 解决 ERR_FAILED (-2) 问题：guest 进程崩溃后 reload()/loadURL()/src 赋值全部通过
 * GUEST_VIEW_MANAGER_CALL IPC 异步失败，try/catch 无法捕获。此函数：
 * 1. 通过外部传入 domReady 状态提前判断走 reload 还是 loadURL
 * 2. 对 reload()/loadURL() 的返回值做 promise 兜底 catch，异步失败时自动回退 loadURL
 * 3. loadURL 也失败时，派发 DOM 事件通知 WebviewTab 触发 remount（唯一可靠恢复手段）
 *
 * 关键：ERR_ABORTED (-3) 不视为 fatal —— 它表示导航被另一导航中断（SPA 多次重定向、
 * 用户连续点击等常见场景），属正常行为，不应触发 remount。仅 ERR_FAILED (-2) 等
 * 表示 guest 进程真正死亡的错误才派发 fatal-failure。
 *
 * @param webview 目标 webview 元素
 * @param fallbackUrl 恢复用的 URL（tab.url / profile.aiPlatformUrl / webview.src）
 * @param domReady webview 是否 dom-ready（false 时直接走 loadURL 恢复路径）
 */
export function safeReloadWebview(
  webview: WebviewElement,
  fallbackUrl: string,
  domReady: boolean,
): void {
  // 防御性 URL 清理：去除反引号/单引号等无效字符
  let targetUrl = sanitizeUrl(fallbackUrl);
  // URL 空值预检：若 fallbackUrl 为空/about:blank，尝试从当前 webview 取 URL
  // （智谱清言验证页等 SPA 场景 fallbackUrl 可能为空，导致 reload/loadURL 无目标）
  if (!targetUrl || targetUrl === 'about:blank') {
    try {
      targetUrl = webview.getURL() || '';
    } catch { /* webview 未 attach 时 getURL 可能抛错 */ }
    if (!targetUrl || targetUrl === 'about:blank') {
      console.warn('[webview] reload 目标 URL 为空，跳过 reload');
      return;
    }
    console.log('[webview] fallbackUrl 为空，改用当前 URL:', targetUrl.slice(0, 80));
  }

  // 判断错误是否为 guest 进程死亡的可靠信号。
  // - ERR_ABORTED (-3)：导航被另一导航中断（SPA 重定向、用户连续点击），正常现象，不视为 fatal
  // - ERR_FAILED (-2) 及其它：guest 进程可能已死亡，需触发 remount 恢复
  const isFatalError = (err: unknown): boolean => {
    const msg = (err instanceof Error ? err.message : String(err)) || '';
    // ERR_ABORTED (-3)：导航被中断，非致命
    if (msg.includes('ERR_ABORTED') || /\(-3\)/.test(msg)) return false;
    return true;
  };

  // 终极恢复：guest 进程死亡时，src 赋值也通过 GUEST_VIEW_MANAGER_CALL IPC 失败。
  // 改为派发 DOM 事件通知 WebviewTab 销毁并重建 <webview> 元素（唯一可靠恢复手段）。
  const tryReloadViaSrc = (url: string) => {
    console.warn('[webview] reload/loadURL 均失败，派发 fatal-failure 事件:', url.slice(0, 80));
    try {
      webview.dispatchEvent(new CustomEvent('ai-webview-fatal-failure', { detail: { url } }));
    } catch (e) {
      console.error('[webview] dispatchEvent 失败:', e);
    }
  };

  // loadURL 恢复（带 promise catch 兜底，失败时回退到 src 赋值）
  const tryLoadURL = (url: string) => {
    try {
      const result = webview.loadURL(url) as unknown;
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((e) => {
          // ERR_ABORTED (-3) 是正常中断（被新导航取消），不视为 fatal
          if (!isFatalError(e)) {
            console.log('[webview] loadURL 被中断（ERR_ABORTED），忽略:', url.slice(0, 80));
            return;
          }
          console.error('[webview] loadURL 异步失败:', e);
          // loadURL 也失败：终极恢复 —— 设置 src 触发 guest 重建
          tryReloadViaSrc(url);
        });
      }
    } catch (e) {
      // 同步抛错且非 ERR_ABORTED：直接尝试 src 赋值
      if (!isFatalError(e)) {
        console.log('[webview] loadURL 同步被中断（ERR_ABORTED），忽略:', e);
        return;
      }
      console.error('[webview] loadURL 同步失败:', e);
      tryReloadViaSrc(url);
    }
  };

  if (domReady) {
    try {
      const result = webview.reload() as unknown;
      if (result && typeof (result as Promise<void>).catch === 'function') {
        // reload() 返回 promise：异步失败时回退到 loadURL
        (result as Promise<void>).catch((e) => {
          if (!isFatalError(e)) {
            console.log('[webview] reload 被中断（ERR_ABORTED），忽略');
            return;
          }
          console.warn('[webview] reload 异步失败（guest 可能已崩溃），回退 loadURL');
          tryLoadURL(targetUrl);
        });
      }
    } catch (e) {
      if (!isFatalError(e)) {
        console.log('[webview] reload 同步被中断（ERR_ABORTED），忽略');
        return;
      }
      // 同步抛错：直接回退到 loadURL
      console.warn('[webview] reload 同步失败，回退 loadURL:', e);
      tryLoadURL(targetUrl);
    }
  } else {
    // guest 进程未就绪/已崩溃：reload() 会 ERR_FAILED，直接 loadURL 恢复
    console.log('[webview] guest 未就绪，用 loadURL 恢复:', targetUrl.slice(0, 80));
    tryLoadURL(targetUrl);
  }
}

/**
 * 安全加载指定 URL（导航到首页/自定义 URL）：
 * - loadURL() 在 Electron 中返回 Promise，异步失败（ERR_FAILED）无法被 try/catch 捕获
 * - 此函数对 loadURL() 的返回值做 Promise catch 兜底
 * - ERR_FAILED (-2) 通常表示 guest 渲染进程已崩溃，loadURL 和 src 赋值都通过
 *   GUEST_VIEW_MANAGER_CALL IPC 异步失败；此时派发 'ai-webview-fatal-failure' DOM 事件，
 *   通知 WebviewTab 销毁并重建 <webview> 元素（唯一可靠恢复手段）
 *
 * 关键：ERR_ABORTED (-3) 不视为 fatal —— 它表示导航被另一导航中断（SPA 重定向、
 * 用户连续点击等），属正常行为，不应触发 remount。
 *
 * @param webview 目标 webview 元素
 * @param url 目标 URL
 */
export function safeLoadURLWebview(webview: WebviewElement, url: string): void {
  // 防御性 URL 清理：去除反引号/单引号等无效字符
  const cleanUrl = sanitizeUrl(url);
  if (!cleanUrl || cleanUrl === 'about:blank') {
    console.warn('[webview] loadURL 目标 URL 为空，跳过');
    return;
  }

  // 判断错误是否为 guest 进程死亡的可靠信号。
  // ERR_ABORTED (-3) 是正常中断（被新导航取消），不应触发 remount。
  const isFatalError = (err: unknown): boolean => {
    const msg = (err instanceof Error ? err.message : String(err)) || '';
    if (msg.includes('ERR_ABORTED') || /\(-3\)/.test(msg)) return false;
    return true;
  };

  // guest 进程死亡时，loadURL 和 src 赋值都通过 GUEST_VIEW_MANAGER_CALL IPC 失败。
  // 唯一可靠恢复：派发 DOM 事件通知 WebviewTab 销毁并重建 <webview> 元素。
  const dispatchFatalFailure = () => {
    console.warn('[webview] loadURL 失败(guest 可能已死)，派发 fatal-failure 事件:', cleanUrl.slice(0, 80));
    try {
      webview.dispatchEvent(new CustomEvent('ai-webview-fatal-failure', { detail: { url: cleanUrl } }));
    } catch (e) {
      console.error('[webview] dispatchEvent 失败:', e);
    }
  };

  try {
    const result = webview.loadURL(cleanUrl) as unknown;
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch((e) => {
        // ERR_ABORTED (-3) 是正常中断（被新导航取消），不视为 fatal
        if (!isFatalError(e)) {
          console.log('[webview] loadURL 被中断（ERR_ABORTED），忽略:', cleanUrl.slice(0, 80));
          return;
        }
        console.error('[webview] loadURL 异步失败:', e);
        dispatchFatalFailure();
      });
    }
  } catch (e) {
    if (!isFatalError(e)) {
      console.log('[webview] loadURL 同步被中断（ERR_ABORTED），忽略:', cleanUrl.slice(0, 80));
      return;
    }
    console.error('[webview] loadURL 同步失败:', e);
    dispatchFatalFailure();
  }
}

export interface InjectViewportOptions {
  /**
   * 是否注入清除网页右侧阴影/滚动条光晕并强制亮色 color-scheme 的样式块。
   * MainView 启用，StandaloneView 不启用。默认 false。
   */
  injectShadowStyle?: boolean;
}

/**
 * 向 webview 注入：
 * 1. 强制移动端 viewport，防止部分网页因 viewport 宽度计算错误出现横向滚动/阴影
 * 2.（可选）清除右侧阴影/滚动条光晕，强制亮色 color-scheme
 * 3. 兜底拦截 window.open 与 target="_blank"，统一在当前页内跳转
 *
 * 注入脚本的 JS 内容与原内联实现逐字一致，仅抽取到函数体；调用时机（dom-ready）不变。
 */
export async function injectViewportAndPopupGuard(
  webview: WebviewElement,
  options: InjectViewportOptions = {},
): Promise<void> {
  const { injectShadowStyle = false } = options;

  // 仅 MainView 启用的阴影/滚动条样式块（前导换行对应原空行，结尾换行对应原空行）
  const shadowBlock = injectShadowStyle
    ? `
            // 3. 清除网页右侧阴影/渐变/滚动条光晕；强制亮色 color-scheme，避免黑暗模式下未定义背景的页面变黑
            try {
              const id = '__ai_no_shadow__';
              if (!document.getElementById(id)) {
                const s = document.createElement('style');
                s.id = id;
                s.textContent = ':root { color-scheme: light; } * { box-shadow: none !important; text-shadow: none !important; } ::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; background: transparent !important; } ::-webkit-scrollbar-track, ::-webkit-scrollbar-thumb, ::-webkit-scrollbar-corner { background: transparent !important; }';
                document.head.appendChild(s);
              }
            } catch (e) { /* webview 上下文错误已通过返回值上报 */ }
`
    : '';

  // // 4. 注释仅在 MainView（injectShadowStyle=true）中出现
  const popupGuardComment = injectShadowStyle
    ? '            // 4. 弹窗兜底：保留 window.open 原引用，拦截逻辑由主进程 setWindowOpenHandler 统一处理\n'
    : '';

  await webview.executeJavaScript(`
          (function() {
            let meta = document.querySelector('meta[name="viewport"]');
            if (!meta) {
              meta = document.createElement('meta');
              meta.name = 'viewport';
              document.head.appendChild(meta);
            }
            meta.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover';
            document.body.style.overflowX = 'hidden';
            document.documentElement.style.overflowX = 'hidden';
${shadowBlock}
${popupGuardComment}            try {
              // 不覆盖 window.open：主进程 setWindowOpenHandler 统一处理弹窗拦截，
              // 可根据白名单决定放行（登录/OAuth）或页面内跳转，并在 guest 崩溃时触发 remount。
              // 此处仅保留 originalOpen 引用，供页面脚本需要时使用。
              window.__ai_originalOpen = window.open;
            } catch (e) { /* webview 上下文错误已通过返回值上报 */ }

            document.addEventListener('click', function(e) {
              const a = e.target.closest && e.target.closest('a');
              if (!a) return;
              const href = a.getAttribute('href') || a.href;
              const target = a.getAttribute('target');
              if (target === '_blank' && href && href !== '#' && href !== 'javascript:;') {
                // 仅拦截同域 _blank 链接做页面内跳转；跨域链接交给浏览器原生处理
                // （触发主进程 setWindowOpenHandler，按跨域策略 allow 开独立窗口，
                //   避免跨域 loadURL 触发 ERR_FAILED 导致 guest 崩溃）
                var linkOrigin = '';
                var absUrl = '';
                try {
                  absUrl = new URL(href, window.location.href).href;
                  linkOrigin = new URL(absUrl).origin;
                } catch (err) { /* 无效 URL，放行默认行为 */ return; }
                if (linkOrigin !== window.location.origin) {
                  console.log('[AIWindow] 跨域 _blank 链接，放行原生 window.open:', href);
                  return;
                }
                // 额外收紧：会话 URL（/c/, /chat/, /conversation/ 等）放行原生处理，
                // 避免与站点 SPA 路由冲突（这些 URL 通常由站点自身路由器处理）
                // 包含常见 AI 平台对话页路径模式：/c/<id>、/g/<id>、/chat/<id>、
                // /conversation/<id>、/dialog/<id>、/dialogue/<id>、/app/<id>、
                // /message/<id>、/prompt/<id>，以及无 id 的新建对话路径
                try {
                  var pathname = new URL(absUrl).pathname || '';
                  // 会话 URL 路径前缀清单（含 id 形式）
                  var conversationPrefixes = [
                    '/c/', '/g/', '/chat/', '/conversation/',
                    '/dialog/', '/dialogue/', '/app/',
                    '/message/', '/prompt/', '/thread/'
                  ];
                  // 无 id 的新建会话路径
                  var newConversationPaths = [
                    '/c/new', '/new', '/chat', '/chat/new', '/g/new'
                  ];
                  var isConversation = conversationPrefixes.some(function(p) { return pathname.indexOf(p) === 0; })
                    || newConversationPaths.indexOf(pathname) !== -1;
                  if (isConversation) {
                    console.log('[AIWindow] 会话 URL，放行原生处理:', href);
                    return;
                  }
                  // 登录/认证 URL 路径前缀清单：放行原生处理（交由 setWindowOpenHandler 决策）
                  // 这些 URL 若被强制 SPA 路由跳转会破坏模态登录流程
                  var loginPrefixes = [
                    '/auth/', '/login/', '/oauth/', '/signin/', '/signup/',
                    '/register/', '/account/', '/sso/', '/callback/',
                    '/applyAndLogin', '/applyandlogin'
                  ];
                  var isLogin = loginPrefixes.some(function(p) { return pathname.indexOf(p) === 0; });
                  if (isLogin) {
                    console.log('[AIWindow] 登录/认证 URL，放行原生处理:', href);
                    return;
                  }
                } catch (err) { /* URL 解析失败，继续拦截 */ }

                e.preventDefault();
                e.stopPropagation();
                console.log('[AIWindow] 拦截同域 _blank 链接，SPA 路由跳转:', href);
                // 优先 SPA 路由（pushState + popstate），避免全页 reload 导致白屏闪烁
                // 与 WebviewTab.tsx onWebviewPopupUrl handler 保持一致
                try {
                  if (window.location.href === absUrl) return; // 同 URL 跳过
                  history.pushState({}, '', absUrl);
                  window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
                } catch (err) {
                  // pushState 失败（如跨域），回退到 location.href
                  console.warn('[AIWindow] SPA 路由失败，回退 location.href:', err);
                  window.location.href = href;
                }
              }
            }, true);
          })();
        `);
}
