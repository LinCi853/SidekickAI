/* =====================================================================
   lib/cookie-handler.ts —— Cookie 弹窗自动处理注入脚本生成（需求 7）
   生成注入到 webview 的 IIFE 脚本：
   1. 检测常见 cookie consent 库（OneTrust / Cookiebot / Quantcast / TrustArc / SourcePoint）
   2. 通用 CSS 选择器匹配（#onetrust-accept-btn-handler 等）
   3. 白名单域名 → 自动点击"Accept All"按钮
   4. 黑名单域名 → 注入 CSS 隐藏所有 cookie 弹窗
   5. 冷却机制：在 webview sessionStorage 内记录每个域名的最后处理时间，冷却期内不重复处理
   ===================================================================== */

/** Cookie 弹窗处理配置（从 AppSettings 传入） */
export interface CookieHandlerConfig {
  /** 白名单域名（自动点击"接受全部"） */
  whitelist: string[]
  /** 黑名单域名（直接隐藏所有 cookie 弹窗） */
  blacklist: string[]
  /** 同域名冷却时间（ms） */
  cooldownMs: number
  /** 总开关 */
  enabled: boolean
}

/** 常见 cookie consent 库的"接受全部"按钮选择器（按优先级排序） */
const ACCEPT_ALL_SELECTORS = [
  // OneTrust
  '#onetrust-accept-btn-handler',
  '#onetrust-button-group #accept-recommended-btn-handler',
  // Cookiebot
  '#CybotCookiebotDialogBodyButtonAccept',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  // Quantcast
  '.qc-cmp2-summary-buttons button[mode="primary"]',
  '.qc-cmp2-buttons button[data-action="agree"]',
  // TrustArc
  '#truste-consent-button',
  '.truste-button2',
  // SourcePoint
  'button.sp_choice_type_11',
  'button[title*="Accept"]',
  'button[title*="Accept All"]',
  // 通用：常见 id / class 模式
  '[id*="accept-cookies"]',
  '[id*="accept-all"]',
  '[class*="cookie-consent"] button[class*="accept"]',
  '[class*="cookie-consent"] button[class*="allow"]',
  '[class*="cookie-banner"] button[class*="accept"]',
  '[data-testid*="cookie-accept"]',
  '[data-testid*="accept-cookies"]',
  // 注：:has-text() 是 Playwright 伪选择器，document.querySelector 不支持，
  // 文本兜底匹配在 findAcceptButton 内通过遍历容器子按钮实现（见下）
]

/** Cookie 弹窗容器的 CSS 选择器（用于黑名单隐藏 + MutationObserver 范围限定） */
const COOKIE_CONTAINER_SELECTORS = [
  '#onetrust-banner-sdk',
  '#onetrust-consent-sdk',
  '#CybotCookiebotDialog',
  '#qc-cmp2-container',
  '.qc-cmp2-container',
  '#truste-consent-track',
  '.truste-consent-content',
  '[id*="cookie-consent"]',
  '[id*="cookie-banner"]',
  '[id*="cookie-popup"]',
  '[class*="cookie-consent"]',
  '[class*="cookie-banner"]',
  '[class*="cookie-popup"]',
  '[class*="cookie-notice"]',
  '[data-testid*="cookie-consent"]',
  '[data-testid*="cookie-banner"]',
]

/**
 * 生成 Cookie 弹窗处理注入脚本。
 *
 * @param hostname 当前页面 hostname（用于判断白/黑名单匹配 + 冷却记录 key）
 * @param config Cookie 处理配置
 * @returns IIFE 脚本字符串；config.enabled=false 或无匹配规则时返回空串
 */
export function buildCookieHandlerScript(hostname: string, config: CookieHandlerConfig): string {
  if (!config.enabled) return ''

  const inWhitelist = matchDomainList(config.whitelist, hostname)
  const inBlacklist = matchDomainList(config.blacklist, hostname)
  if (!inWhitelist && !inBlacklist) return ''

  // 黑名单：注入 CSS 隐藏所有 cookie 弹窗
  if (inBlacklist) {
    const hideCss = COOKIE_CONTAINER_SELECTORS.map((s) => `${s} { display: none !important; }`).join('\n')
    const hostnameJson = JSON.stringify(hostname)
    return `(function() {
      if (window.__ai_cookie_handler_injected__) return;
      window.__ai_cookie_handler_injected__ = true;
      var style = document.createElement('style');
      style.id = '__ai_cookie_hide__';
      style.textContent = ${JSON.stringify(hideCss)};
      (document.head || document.documentElement).appendChild(style);
      console.log('[cookie-handler] 黑名单域名，已隐藏 cookie 弹窗: ' + ${hostnameJson});
    })();`
  }

  // 白名单：自动点击"接受全部"按钮 + 冷却机制
  const acceptSelectors = JSON.stringify(ACCEPT_ALL_SELECTORS)
  const containerSelectors = JSON.stringify(COOKIE_CONTAINER_SELECTORS)
  const hostnameJson = JSON.stringify(hostname)
  return `(function() {
    if (window.__ai_cookie_handler_injected__) return;
    window.__ai_cookie_handler_injected__ = true;

    var COOLDOWN_MS = ${config.cooldownMs};
    var HOSTNAME = ${hostnameJson};
    var ACCEPT_SELECTORS = ${acceptSelectors};
    var CONTAINER_SELECTORS = ${containerSelectors};
    var cooldownKey = '__ai_cookie_last_handle_' + HOSTNAME;

    function getLastHandled() {
      try { return parseInt(sessionStorage.getItem(cooldownKey) || '0', 10); } catch (e) { return 0; }
    }
    function setLastHandled() {
      try { sessionStorage.setItem(cooldownKey, String(Date.now())); } catch (e) { /* ignore */ }
    }

    function findAcceptButton() {
      for (var i = 0; i < ACCEPT_SELECTORS.length; i++) {
        try {
          var found = document.querySelector(ACCEPT_SELECTORS[i]);
          if (found) return found;
        } catch (e) { /* invalid selector, skip */ }
      }
      // 兜底：在 cookie 容器内查找包含"Accept"文本的按钮
      for (var j = 0; j < CONTAINER_SELECTORS.length; j++) {
        try {
          var container = document.querySelector(CONTAINER_SELECTORS[j]);
          if (!container) continue;
          var buttons = container.querySelectorAll('button, a, [role="button"]');
          for (var k = 0; k < buttons.length; k++) {
            var text = (buttons[k].textContent || '').trim().toLowerCase();
            if (text.indexOf('accept') !== -1 || text.indexOf('agree') !== -1 || text.indexOf('allow all') !== -1) {
              return buttons[k];
            }
          }
        } catch (e) { /* ignore */ }
      }
      return null;
    }

    function tryClick() {
      // 冷却期内不重复处理
      if (Date.now() - getLastHandled() < COOLDOWN_MS) {
        return true;
      }
      var btn = findAcceptButton();
      if (!btn) return false;
      try {
        btn.click();
        setLastHandled();
        console.log('[cookie-handler] 已自动点击"接受全部"按钮: ' + HOSTNAME);
        return true;
      } catch (e) {
        console.warn('[cookie-handler] 点击按钮失败:', e);
        return false;
      }
    }

    // 首次尝试
    if (tryClick()) return;

    // MutationObserver：监听 cookie 容器动态渲染
    var observer = new MutationObserver(function() {
      if (tryClick()) {
        observer.disconnect();
      }
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });

    // 10 秒后停止监听（避免长期占用）
    setTimeout(function() {
      observer.disconnect();
    }, 10000);
  })();`
}

/**
 * 域名列表匹配（支持通配符）。
 * - 'example.com' 匹配 example.com 及其子域名
 * - '*.example.com' 匹配子域名（不含 example.com 本身）
 * - '*' 匹配所有
 */
function matchDomainList(patterns: string[], hostname: string): boolean {
  for (const pattern of patterns) {
    if (pattern === '*') return true
    if (pattern.startsWith('*.')) {
      const base = pattern.slice(2)
      if (hostname === base || hostname.endsWith('.' + base)) return true
    } else {
      if (hostname === pattern || hostname.endsWith('.' + pattern)) return true
    }
  }
  return false
}
