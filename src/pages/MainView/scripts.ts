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
