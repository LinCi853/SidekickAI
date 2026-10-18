import type { BlockRule } from '../../electron/shared/types'

export function buildBlockerScript(rules: BlockRule[]): string {
  const cssRules = rules.filter(rule => rule.type === 'css' && rule.selector)
  const jsRules = rules.filter(rule => rule.type === 'js' && rule.jsCode)
  return `(function() {
    if (window.__ai_blocker_state__) window.__ai_blocker_state__.dispose();
    var cssRules = ${JSON.stringify(cssRules.map(rule => ({ id: rule.id, selector: rule.selector })))};
    var jsRules = ${JSON.stringify(jsRules.map(rule => ({ id: rule.id, code: rule.jsCode })))};
    var style = document.createElement('style');
    style.id = '__ai_block_style__';
    (document.head || document.documentElement).appendChild(style);
    var css = [];
    var errors = [];
    function reportError(id, error) {
      var existing = errors.find(function(item) { return item.id === id; });
      if (existing) existing.message = String(error);
      else errors.push({ id: id, message: String(error) });
    }
    for (var i = 0; i < cssRules.length; i++) {
      try {
        document.querySelector(cssRules[i].selector);
        css.push(cssRules[i].selector + ' { display: none !important; visibility: hidden !important; }');
      } catch (error) {
        reportError(cssRules[i].id, error);
        console.warn('[blocker] Invalid selector (' + cssRules[i].id + '):', error);
      }
    }
    style.textContent = css.join('\\n');
    var observer;
    var disposed = false;
    var state = { requiresReload: jsRules.length > 0, errors: errors, dispose: function() {
      if (disposed) return;
      disposed = true;
      if (state.clearPending) state.clearPending();
      if (observer) observer.disconnect();
      style.remove();
      window.removeEventListener('pagehide', state.dispose);
      if (window.__ai_blocker_state__ === state) {
        delete window.__ai_blocker_state__;
        delete window.__ai_blocker_injected__;
        if (state.requiresReload) window.__ai_blocker_reload_required__ = true;
      }
    } };
    window.__ai_blocker_state__ = state;
    window.__ai_blocker_injected__ = true;
    // 规则代码只编译一次：此前每次 DOM 变更都 new Function，在流式回复页面上
    // 一次生成就能编译上百次，主线程被无谓占满。
    var compiled = [];
    for (var c = 0; c < jsRules.length; c++) {
      try { compiled.push({ id: jsRules[c].id, fn: new Function(jsRules[c].code) }); }
      catch (error) { reportError(jsRules[c].id, error); console.warn('[blocker] Script failed (' + jsRules[c].id + '):', error); }
    }
    function applyJs() {
      if (disposed) return;
      for (var k = 0; k < compiled.length; k++) {
        try { compiled[k].fn(); }
        catch (error) {
          reportError(compiled[k].id, error);
          console.warn('[blocker] Script failed (' + compiled[k].id + '):', error);
        }
      }
    }
    applyJs();
    if (compiled.length) {
      // 用户写的 js 规则常见形态是「移除/隐藏后来才出现的元素」，所以必须跟着 DOM 变化重跑；
      // 之前的性能问题是每次变更都 new Function 重编译全部规则，现在只编译一次（上面），
      // 重跑的成本只剩规则自身的执行，再叠一个 250ms 尾部合并，避免流式回复时每帧都跑。
      var pendingTimer = null;
      var schedule = function() {
        if (disposed) return;
        // 没有定时器的宿主（测试沙箱）退化成同步重跑
        if (typeof setTimeout !== 'function') { applyJs(); return; }
        if (pendingTimer !== null) return;
        pendingTimer = setTimeout(function() {
          pendingTimer = null;
          applyJs();
        }, 250);
      };
      observer = new MutationObserver(function(mutations) {
        if (disposed) return;
        if (!mutations.some(function(mutation) { return mutation.addedNodes.length > 0; })) return;
        schedule();
      });
      observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
      state.clearPending = function() {
        if (pendingTimer !== null && typeof clearTimeout === 'function') clearTimeout(pendingTimer);
        pendingTimer = null;
      };
    }
    window.addEventListener('pagehide', state.dispose, { once: true });
    return { requiresReload: state.requiresReload, errors: errors };
  })();`
}

export function buildBlockerCleanupScript(): string {
  return `(function() {
    var state = window.__ai_blocker_state__;
    if (state) state.dispose();
    return { requiresReload: !!window.__ai_blocker_reload_required__ };
  })();`
}

export function matchDomain(pattern: string, hostname: string): boolean {
  if (!pattern || !hostname) return false
  if (pattern === '*') return true
  const base = pattern.startsWith('*.') ? pattern.slice(2) : pattern
  return hostname === base || hostname.endsWith('.' + base)
}
