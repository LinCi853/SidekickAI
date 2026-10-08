import type { AIPlatformPageAdapter } from '../../../electron/shared/profile.types.js';

/* =====================================================================
   注入脚本：抓取网页对话内容（运行在 webview 网页上下文，返回 JSON 字符串）
   策略：
   1. 按 location.hostname 匹配 PLATFORM_SELECTORS 中对应平台的精准选择器（9 平台）
   2. 平台选择器未命中时，尝试 FALLBACK_SELECTORS 通用兜底
   3. 全量抓取当前对话所有可见消息（非仅最新一轮），按顺序配对为 pairs 数组
   4. 数据库 UNIQUE INDEX (conversation_id, content_hash) 自动去重，无需脚本侧去重
   返回 { pairs: [{user, assistant}], title, url }。
   ===================================================================== */
export const SCRAPE_CHAT_SCRIPT = `(function() {
  try {
    var title = document.title || '';
    var url = location.href;

    // 按 hostname 分组的精准选择器（9 平台）
    var PLATFORM_SELECTORS = {
      // ChatGPT
      'chatgpt.com': {
        user: ['[data-message-author-role="user"]'],
        assistant: ['[data-message-author-role="assistant"]']
      },
      // Claude
      'claude.ai': {
        user: ['[data-testid="user-message"]'],
        assistant: ['[data-testid="ai-response"]', 'div.font-claude-message']
      },
      // Gemini
      'gemini.google.com': {
        user: ['.query-text', '[data-test-id="user-query"]', 'div.query-content'],
        assistant: ['.response-container', '.model-response-text', '[data-test-id="model-response"]']
      },
      // 豆包
      'doubao.com': {
        user: ['[data-testid="user_message"]', 'div[data-testid*="user"]'],
        assistant: ['[data-testid="assistant_message"]', 'div[data-testid*="answer"]', '.receive-message']
      },
      // 智谱清言
      'chatglm.cn': {
        user: ['.chat-item-user', 'div[class*="user-message"]', 'div[class*="user-content"]'],
        assistant: ['.chat-item-ai', '.chat-item-assistant', 'div[class*="ai-message"]', 'div[class*="markdown"]']
      },
      // DeepSeek（BEM 命名约定，精准匹配避免误中输入区域）
      'chat.deepseek.com': {
        user: ['div.ds-message--user', 'div[class*="ds-message"][class*="user"]', 'div[role="user"]'],
        assistant: ['div.ds-message--assistant', 'div[class*="ds-message"][class*="assistant"]', 'div[role="assistant"]']
      },
      // Kimi
      'kimi.moonshot.cn': {
        user: ['.message-block.user', 'div[class*="message-block"][class*="user"]', '.user-message'],
        assistant: ['.message-block.assistant', 'div[class*="message-block"][class*="assistant"]', '.ai-message']
      },
      // 文心一言
      'yiyan.baidu.com': {
        user: ['.user-question', '#user-question', 'div[class*="question"]'],
        assistant: ['.ai-answer', '.answer-content', '#ai-answer', 'div[class*="answer"]']
      },
      // 小米 Mimo
      'mimo.xiaomi.com': {
        user: ['.user-msg', 'div[class*="user-msg"]', '.user-message'],
        assistant: ['.assistant-msg', '.ai-msg', 'div[class*="assistant-msg"]', '.model-response']
      }
    };

    // 通用兜底（平台选择器未命中时尝试）
    var FALLBACK_SELECTORS = {
      user: ['[data-testid*="user"]', '[class*="user-message"]', '[class*="human-message"]', '.from-user', '.user-side', '[role="user"]', 'div[class*="user"]'],
      assistant: ['[data-testid*="assistant"]', '[data-testid*="answer"]', '[class*="assistant-message"]', '[class*="ai-message"]', '.from-ai', '.from-assistant', '.assistant-side', '[role="assistant"]', '.prose', 'article', 'div[class*="answer"]', 'div[class*="response"]']
    };

    function getSelectorsForCurrentHost() {
      var host = location.hostname;
      for (var pattern in PLATFORM_SELECTORS) {
        if (host.indexOf(pattern) >= 0) return PLATFORM_SELECTORS[pattern];
      }
      return null;
    }

    function queryAllMatches(selectors) {
      for (var i = 0; i < selectors.length; i++) {
        try {
          var els = document.querySelectorAll(selectors[i]);
          if (els && els.length > 0) return els;
        } catch (e) { /* webview 上下文错误已通过返回值上报 */ }
      }
      return null;
    }

    var platformSelectors = getSelectorsForCurrentHost();
    var userEls = platformSelectors ? queryAllMatches(platformSelectors.user) : null;
    var asstEls = platformSelectors ? queryAllMatches(platformSelectors.assistant) : null;
    console.log('[Scrape] hostname=', location.hostname, 'platformSelectors命中=', !!platformSelectors, 'userEls=', userEls ? userEls.length : 0, 'asstEls=', asstEls ? asstEls.length : 0);
    // 平台选择器未命中时尝试通用兜底
    if (!userEls) userEls = queryAllMatches(FALLBACK_SELECTORS.user);
    if (!asstEls) asstEls = queryAllMatches(FALLBACK_SELECTORS.assistant);
    if (platformSelectors && (!userEls || !asstEls)) {
      console.log('[Scrape] 平台选择器部分未命中, fallback 后 userEls=', userEls ? userEls.length : 0, 'asstEls=', asstEls ? asstEls.length : 0);
    }

    // 全量配对：按顺序取所有消息，长度不等时取 max（缺失方留空字符串）
    var allPairs = [];
    if (userEls || asstEls) {
      var userLen = userEls ? userEls.length : 0;
      var asstLen = asstEls ? asstEls.length : 0;
      var maxLen = Math.max(userLen, asstLen);
      for (var i = 0; i < maxLen; i++) {
        var u = '';
        var a = '';
        if (userEls && i < userEls.length) {
          u = (userEls[i].innerText || userEls[i].textContent || '').trim();
        }
        if (asstEls && i < asstEls.length) {
          a = (asstEls[i].innerText || asstEls[i].textContent || '').trim();
        }
        if (u || a) allPairs.push({ user: u, assistant: a });
      }
    }
    console.log('[Scrape] 最终 pairs=', allPairs.length, 'path=', location.pathname);

    return JSON.stringify({ pairs: allPairs, title: title, url: url });
  } catch (e) {
    return JSON.stringify({ error: String((e && e.message) || e) });
  }
})()`;

/* =====================================================================
   注入脚本：检测登录态（运行在 webview 网页上下文，返回 JSON 字符串）
   通过常见用户菜单/头像元素 + cookie 摘要判定是否已登录。
   ===================================================================== */
export const DETECT_LOGIN_SCRIPT = `(function() {
  try {
    var url = location.href;
    var cookie = document.cookie || '';
    var isLoggedIn = false;
    var indicators = [
      '[data-testid*="account"]',
      '[data-testid*="user-menu"]',
      '[data-testid*="avatar"]',
      '[data-testid*="profile"]',
      '[class*="user-avatar"]',
      '[class*="account-menu"]',
      '[class*="avatar"]',
      'img[alt*="avatar" i]',
      'button[aria-label*="account" i]',
      'button[aria-label*="menu" i]'
    ];
    for (var i = 0; i < indicators.length; i++) {
      try { if (document.querySelector(indicators[i])) { isLoggedIn = true; break; } } catch (e) { /* webview 上下文错误已通过返回值上报 */ }
    }
    if (!isLoggedIn && /(session|token|auth|uid|userid|login|sid)=/i.test(cookie)) {
      isLoggedIn = true;
    }
    return JSON.stringify({ url: url, cookie: cookie.slice(0, 2000), isLoggedIn: isLoggedIn });
  } catch (e) {
    return JSON.stringify({ error: String((e && e.message) || e) });
  }
})()`;

/* =====================================================================
   注入脚本：Enter 发送 / Shift+Enter 换行行为（运行在 webview 网页上下文）。
   始终注入监听器，通过运行时标志 window.__ai_enter_send_enabled__ 控制开关，
   这样设置面板切换 enterToSend 时无需重新注入，只需更新标志位。
   返回可直接传入 executeJavaScript 的完整 IIFE 字符串。
   ===================================================================== */
export function buildEnterToSendScript(opts: {
  enabled: boolean;
  inputSelector?: string | null;
  sendSelector?: string | null;
  pageAdapter?: AIPlatformPageAdapter | null;
}): string {
  return `(function() {
    if (window.__ai_enter_send_injected__) {
      if (window.__ai_enter_send__) window.__ai_enter_send__.dispose();
    }
    if (!${opts.enabled}) return;
    var pageAdapter = ${JSON.stringify(opts.pageAdapter ?? null)};
    if (pageAdapter && (pageAdapter.version !== 1 || pageAdapter.hosts.indexOf(location.hostname) === -1)) return;
    window.__ai_enter_send_injected__ = true;
    window.__ai_enter_send_enabled__ = ${opts.enabled};
    var inputSel = ${JSON.stringify(opts.inputSelector ?? null)};
    var sendSel = ${JSON.stringify(opts.sendSelector ?? null)};
    console.log('[EnterSend] 注入监听器, inputSel=', inputSel, 'sendSel=', sendSel, 'enabled=', window.__ai_enter_send_enabled__);

    function isShown(element) {
      if (element.closest('[hidden], [inert]')) return false;
      var rect = element.getBoundingClientRect();
      var style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function findSendButton(inputEl) {
      var input = inputEl.closest('textarea, input, [contenteditable="true"], [contenteditable=""]');
      if (!input) return null;
      var selector = sendSel || 'button[type="submit"], button[aria-label="Send"], button[aria-label="send"], button[aria-label="\\u53d1\\u9001"]';
      for (var scope = input.parentElement; scope && scope !== document.body && scope !== document.documentElement; scope = scope.parentElement) {
        if (hasOtherInput(scope, input)) return null;
        var buttons = queryButtons(scope, selector).filter(isShown);
        if (buttons.length) return buttons.length === 1 && canClickButton(buttons[0], pageAdapter && pageAdapter.disabledSelector) ? buttons[0] : null;
        if (scope.tagName === 'FORM') return null;
      }
      return null;
    }

    function isEditable(el, includeUnavailable) {
      if (!el) return false;
      var tag = el.tagName;
      if (tag === 'TEXTAREA' || (tag === 'INPUT' && ['text', 'search', 'url', 'email', 'tel'].indexOf(el.type || 'text') !== -1)) return includeUnavailable || (!el.disabled && !el.readOnly);
      if (el.isContentEditable) return true;
      return false;
    }

    function hasOtherInput(scope, input) {
      return Array.from(scope.querySelectorAll('textarea, input, [contenteditable="true"], [contenteditable=""]')).some(function(other) {
        return isEditable(other, true) && !other.contains(input) && !input.contains(other);
      });
    }

    function queryButtons(scope, selector, labels) {
      try {
        return Array.from(scope.querySelectorAll(selector)).filter(function(button) {
          if (!labels) return true;
          var names = [button.getAttribute('aria-label'), button.getAttribute('title'), button.value, button.textContent];
          return names.some(function(name) {
            return name && labels.some(function(label) {
              return name.trim().replace(/\\s+/g, ' ').toLowerCase() === label.toLowerCase();
            });
          });
        });
      } catch (_) { return []; }
    }

    function findEditActions(target) {
      if (!pageAdapter) return null;
      var input = target.closest('textarea, input, [contenteditable="true"], [contenteditable=""]');
      if (!input) return null;
      if (pageAdapter.nativeComposerSelector && input.closest(pageAdapter.nativeComposerSelector)) return { send: null, cancel: null };
      var edit = pageAdapter.messageEdit;
      var root = edit.rootSelector ? input.closest(edit.rootSelector) : null;
      if (edit.rootSelector && !root) return null;
      if (root === input) return { send: null, cancel: null };
      var pending = null;
      for (var scope = input.parentElement; scope && scope !== document.body && scope !== document.documentElement; scope = scope.parentElement) {
        if (hasOtherInput(scope, input)) return pending || (root ? { send: null, cancel: null } : null);
        var sends = queryButtons(scope, edit.sendSelector, edit.sendLabels);
        var cancels = queryButtons(scope, edit.cancelSelector, edit.cancelLabels);
        if (sends.length && cancels.length) {
          var visibleSends = sends.filter(isShown);
          var visibleCancels = cancels.filter(isShown);
          return {
            send: visibleSends.length === 1 ? visibleSends[0] : null,
            cancel: visibleCancels.length === 1 ? visibleCancels[0] : null
          };
        }
        if (sends.length || cancels.length) pending = { send: null, cancel: null };
        if (scope === root) return pending || { send: null, cancel: null };
      }
      return pending;
    }

    function canClickButton(button, disabledSelector) {
      return button && isShown(button) && !button.closest('[disabled], [aria-disabled="true"], [data-disabled="true"], [inert]')
        && (!disabledSelector || !button.closest(disabledSelector))
        && window.getComputedStyle(button).pointerEvents !== 'none';
    }

    function onKeyDown(e) {
      if (e.defaultPrevented || (e.key !== 'Enter' && e.key !== 'Escape')) return;
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.repeat || e.keyCode === 229) return;
      if (e.isComposing) return;
      // 运行时开关：由外部通过 window.__ai_enter_send_enabled__ 控制
      if (!window.__ai_enter_send_enabled__) { console.log('[EnterSend] Enter 跳过: 功能未启用'); return; }
      var target = e.target;
      console.log('[EnterSend] Key pressed:', e.key, 'target:', target.tagName);
      if (!isEditable(target)) { console.log('[EnterSend] target 不可编辑，跳过'); return; }
      if (target.closest('dialog, [role="dialog"], nav, aside, [role="menu"], [role="listbox"], [data-login-panel]')) return;
      if (target.closest('[aria-expanded="true"], [aria-activedescendant]:not([aria-activedescendant=""])') || Array.from(document.querySelectorAll('[role="listbox"], [role="menu"]')).some(isShown)) return;
      var editActions = findEditActions(target);
      if (editActions) {
        var editButton = e.key === 'Enter' ? editActions.send : editActions.cancel;
        if (!canClickButton(editButton, pageAdapter.disabledSelector)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        editButton.click();
        return;
      }
      if (e.key !== 'Enter') return;
      if (inputSel) {
        var matched = false;
        var els = document.querySelectorAll(inputSel);
        for (var i = 0; i < els.length; i++) {
          if (els[i] === target || els[i].contains(target)) { matched = true; break; }
        }
        // 模糊回退：SPA 站点可能更换 DOM 结构（如 DeepSeek 从 textarea 换成 contenteditable div），
        // inputSel 不再匹配。此时如果 target 是页面上任何 textarea / contenteditable div，
        // 也视为合法输入框（findSendButton 仍能正确找到发送按钮）。
        if (!matched) {
          var fallbackEls = document.querySelectorAll('textarea, div[contenteditable="true"], div[contenteditable=""]');
          for (var fi = 0; fi < fallbackEls.length; fi++) {
            if (fallbackEls[fi] === target || fallbackEls[fi].contains(target)) { matched = true; break; }
          }
          if (matched) console.log('[EnterSend] inputSel 未匹配但 fallback 命中');
        }
        if (!matched) { console.log('[EnterSend] inputSel 未匹配, 跳过. inputSel=', inputSel); return; }
      }
      console.log('[EnterSend] 开始查找发送按钮, url=', location.pathname);
      // 先查找发送按钮，找到才 preventDefault + click
      // 找不到则不阻止原始事件，让网站自身的 Enter 处理逻辑正常工作
      var sendBtn = findSendButton(target);
      if (!sendBtn) {
        console.log('[EnterSend] 未找到发送按钮，不拦截 Enter，交由网站处理');
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      console.log('[EnterSend] 拦截 Enter, 点击发送按钮:', sendBtn.tagName, 'class=', sendBtn.className);
      try {
        if (pageAdapter && pageAdapter.sendEvent === 'mousedown') sendBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, button: 0 }));
        else sendBtn.click();
        console.log('[EnterSend] 发送按钮 click() 调用完成');
      } catch (err) {
        console.error('[EnterSend] 点击发送按钮失败:', err);
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    var state = { dispose: function() {
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pagehide', state.dispose);
      if (window.__ai_enter_send__ === state) {
        delete window.__ai_enter_send__;
        delete window.__ai_enter_send_injected__;
        delete window.__ai_enter_send_enabled__;
      }
    } };
    window.__ai_enter_send__ = state;
    window.addEventListener('pagehide', state.dispose, { once: true });
    console.log('[EnterSend] 监听器已注册');
  })()`;
}

export function buildEnterToSendCleanupScript(): string {
  return `(function() {
    if (window.__ai_enter_send__) window.__ai_enter_send__.dispose();
  })();`
}
