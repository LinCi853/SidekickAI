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
    function applyJs() {
      if (disposed) return;
      for (var j = 0; j < jsRules.length; j++) {
        try { new Function(jsRules[j].code)(); }
        catch (error) {
          reportError(jsRules[j].id, error);
          console.warn('[blocker] Script failed (' + jsRules[j].id + '):', error);
        }
      }
    }
    applyJs();
    if (jsRules.length) {
      observer = new MutationObserver(function(mutations) {
        if (mutations.some(function(mutation) { return mutation.addedNodes.length > 0; })) applyJs();
      });
      observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
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
