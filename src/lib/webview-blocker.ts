/* =====================================================================
   lib/webview-blocker.ts —— 页面组件屏蔽注入脚本生成器
   参照 uBlock Origin cosmetic filtering 模式：
   - CSS 规则注入 <style> 标签 display:none
   - JS 规则直接执行（重写 confirm/alert 等）
   - MutationObserver 持续清理动态渲染元素
   ===================================================================== */

import type { BlockRule } from '../../electron/shared/types';

/**
 * 构建页面组件屏蔽注入脚本。
 * 由 webview.executeJavaScript 执行，参照 injectViewportAndPopupGuard 模式。
 */
export function buildBlockerScript(rules: BlockRule[]): string {
  const cssRules = rules.filter((r) => r.type === 'css' && r.selector);
  const jsRules = rules.filter((r) => r.type === 'js' && r.jsCode);

  return `(function() {
    if (window.__ai_blocker_injected__) return;
    window.__ai_blocker_injected__ = true;

    var cssRules = ${JSON.stringify(cssRules.map((r) => ({ id: r.id, selector: r.selector })))};
    var jsRules = ${JSON.stringify(jsRules.map((r) => r.jsCode))};

    // 1. 注入 CSS 屏蔽样式
    function applyCss() {
      var id = '__ai_block_style__';
      var style = document.getElementById(id);
      if (!style) {
        style = document.createElement('style');
        style.id = id;
        document.head.appendChild(style);
      }
      var css = '';
      for (var i = 0; i < cssRules.length; i++) {
        css += cssRules[i].selector + ' { display: none !important; visibility: hidden !important; }\\n';
      }
      style.textContent = css;
    }
    applyCss();

    // 2. 执行 JS 屏蔽规则（重写 confirm/alert 等）
    // 使用 new Function 替代 eval：在全局作用域执行，避免闭包变量泄露；
    // 规则来源为用户自配置的 block-rules，属于有意为之的用户自定义脚本执行功能。
    for (var j = 0; j < jsRules.length; j++) {
      try {
        // eslint-disable-next-line no-new-func
        new Function(jsRules[j])();
      } catch (e) {
        console.error('[blocker] JS规则执行失败:', e);
      }
    }

    // 3. MutationObserver：动态内容重新应用 CSS 屏蔽（处理 SPA 动态渲染）
    var observer = new MutationObserver(function(mutations) {
      for (var k = 0; k < mutations.length; k++) {
        if (mutations[k].addedNodes.length > 0) {
          applyCss();
          break;
        }
      }
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  })();`;
}

/**
 * glob 域名匹配（与 store 中 matchDomain 一致）
 * '*' 匹配所有；'*.chatgpt.com' 匹配 'chatgpt.com' 及其子域名
 */
export function matchDomain(pattern: string, hostname: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    return hostname === base || hostname.endsWith('.' + base);
  }
  return hostname === pattern || hostname.endsWith('.' + pattern);
}
