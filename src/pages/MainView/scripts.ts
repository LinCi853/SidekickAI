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
}): string {
  return `(function() {
    if (window.__ai_enter_send_injected__) {
      // 已注入，仅更新标志位
      window.__ai_enter_send_enabled__ = ${opts.enabled};
      return;
    }
    window.__ai_enter_send_injected__ = true;
    window.__ai_enter_send_enabled__ = ${opts.enabled};
    var inputSel = ${JSON.stringify(opts.inputSelector ?? null)};
    var sendSel = ${JSON.stringify(opts.sendSelector ?? null)};
    console.log('[EnterSend] 注入监听器, inputSel=', inputSel, 'sendSel=', sendSel, 'enabled=', window.__ai_enter_send_enabled__);

    function findSendButton(inputEl) {
      console.log('[EnterSend] findSendButton 开始, inputEl=', inputEl.tagName, 'sendSel=', sendSel);
      // 1. 优先用平台配置的 sendSelector
      if (sendSel) {
        var btns = document.querySelectorAll(sendSel);
        console.log('[EnterSend] sendSel 匹配数量:', btns.length);
        for (var i = 0; i < btns.length; i++) {
          var b = btns[i];
          var s = window.getComputedStyle(b);
          var visible = s.display !== 'none' && s.visibility !== 'hidden' && b.offsetParent !== null;
          console.log('[EnterSend] sendSel 候选[' + i + ']:', b.tagName, 'class=', b.className, 'visible=', visible);
          if (visible) {
            console.log('[EnterSend] 找到发送按钮(sendSel):', b);
            return b;
          }
        }
      }
      // 2. 在 input 所属 form 内查找 submit 按钮
      var form = inputEl && inputEl.closest && inputEl.closest('form');
      if (form) {
        var submitBtn = form.querySelector('button[type=submit]');
        if (submitBtn) {
          console.log('[EnterSend] 找到 form submit 按钮');
          return submitBtn;
        }
      }
      // 3. 通用候选按钮：aria-label / class / data-testid 包含 send/发送
      var candidates = document.querySelectorAll(
        'button[aria-label*="发送"], button[aria-label*="Send"], button[aria-label*="send"], ' +
        'button[class*="send" i], button[class*="Send"], ' +
        'div[role="button"][aria-label*="发送"], div[role="button"][aria-label*="Send"], div[role="button"][aria-label*="send"], ' +
        'button[data-testid*="send" i], button[data-testid*="Send"]'
      );
      console.log('[EnterSend] 通用候选按钮数量:', candidates.length);
      for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        var style = window.getComputedStyle(c);
        if (style.display !== 'none' && style.visibility !== 'hidden' && c.offsetParent !== null) {
          console.log('[EnterSend] 找到通用发送按钮:', c);
          return c;
        }
      }
      // 3.5 DeepSeek 等现代 SPA：发送按钮仅靠 class 区分（ds-button--primary--filled--circle--m），
      //     aria-label / "send" 文本都没有，只能靠主题色按钮特征识别：
      //     - 优先精确匹配 --primary + --circle（发送按钮的稳定特征）
      //     - 再 fallback 到含向上箭头 SVG 的 div[role="button"]
      //     注意：不再返回任意 ds-button，避免误点"深度思考"/"联网搜索"等开关按钮
      try {
        // 3.5a 精确匹配 --primary + --circle（发送按钮特征）
        var primaryCircleBtns = document.querySelectorAll(
          'div[role="button"].ds-button--primary.ds-button--circle, ' +
          'div[role="button"][class*="ds-button--primary"][class*="ds-button--circle"]'
        );
        console.log('[EnterSend] DeepSeek --primary--circle 匹配数量:', primaryCircleBtns.length);
        for (var j = 0; j < primaryCircleBtns.length; j++) {
          var pcb = primaryCircleBtns[j];
          var pcs = window.getComputedStyle(pcb);
          var pcbVisible = pcs.display !== 'none' && pcs.visibility !== 'hidden' && pcb.offsetParent !== null;
          console.log('[EnterSend] primary--circle 候选[' + j + ']:', pcb.tagName, 'class=', pcb.className, 'visible=', pcbVisible);
          if (pcbVisible) {
            console.log('[EnterSend] 找到 DeepSeek 发送按钮(--primary--circle):', pcb);
            return pcb;
          }
        }
        // 3.5b 含向上箭头 SVG 的 div[role="button"]
        var roleBtns = document.querySelectorAll('div[role="button"]');
        console.log('[EnterSend] div[role="button"] 总数:', roleBtns.length);
        for (var k = 0; k < roleBtns.length; k++) {
          var rb = roleBtns[k];
          var rs = window.getComputedStyle(rb);
          if (rs.display === 'none' || rs.visibility === 'hidden' || !rb.offsetParent) continue;
          var svg = rb.querySelector && rb.querySelector('svg');
          if (!svg) continue;
          var path = svg.querySelector && svg.querySelector('path');
          if (!path) continue;
          var d = path.getAttribute('d') || '';
          // 匹配向上箭头（M...Y 0 0.981587 表示 SVG 起始点接近顶端）
          if (d.indexOf('M8.3125') === 0 || d.indexOf('M12 4') === 0 || d.indexOf('M12 2') === 0 || /^[Mm]12,?\s*2/.test(d) || /^[Mm]12,?\s*4/.test(d)) {
            console.log('[EnterSend] 找到含向上箭头 SVG 的 role=button:', rb, 'path d=', d);
            return rb;
          }
        }
      } catch (e4) {
        console.error('[EnterSend] DeepSeek 风格按钮查找失败:', e4);
      }
      // 4. 输入框附近的按钮（兄弟/父级子元素）
      if (inputEl && inputEl.parentElement) {
        var nearbyBtns = inputEl.parentElement.querySelectorAll('button:not([disabled]), div[role="button"]');
        console.log('[EnterSend] 输入框附近按钮数量:', nearbyBtns.length);
        // 取最后一个可见按钮（通常是发送按钮）
        var lastBtn = null;
        for (var i = nearbyBtns.length - 1; i >= 0; i--) {
          var nb = nearbyBtns[i];
          var ns = window.getComputedStyle(nb);
          if (ns.display !== 'none' && ns.visibility !== 'hidden' && nb.offsetParent !== null) {
            lastBtn = nb;
            break;
          }
        }
        if (lastBtn) {
          console.log('[EnterSend] 找到附近按钮:', lastBtn, 'class=', lastBtn.className);
          return lastBtn;
        }
      }
      console.log('[EnterSend] 未找到发送按钮');
      return null;
    }

    function isEditable(el) {
      if (!el) return false;
      var tag = el.tagName;
      if (tag === 'TEXTAREA' || (tag === 'INPUT' && (el.type === 'text' || el.type === ''))) return !el.disabled && !el.readOnly;
      if (el.isContentEditable) return true;
      return false;
    }

    document.addEventListener('keydown', function(e) {
      if (e.key !== 'Enter') return;
      if (e.isComposing) { console.log('[EnterSend] Enter 跳过: 输入法组合中'); return; }
      // 运行时开关：由外部通过 window.__ai_enter_send_enabled__ 控制
      if (!window.__ai_enter_send_enabled__) { console.log('[EnterSend] Enter 跳过: 功能未启用'); return; }
      var target = e.target;
      console.log('[EnterSend] Enter 按下, target:', target.tagName, 'id=', target.id, 'class=', target.className);
      if (!isEditable(target)) { console.log('[EnterSend] target 不可编辑，跳过'); return; }
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
      // Shift+Enter = 换行，不拦截
      if (e.shiftKey) { console.log('[EnterSend] Shift+Enter, 换行'); return; }
      // 输入法组合中不拦截
      if (e.keyCode === 229) { console.log('[EnterSend] keyCode=229, 跳过'); return; }
      console.log('[EnterSend] 开始查找发送按钮, url=', location.pathname);
      // 先查找发送按钮，找到才 preventDefault + click
      // 找不到则不阻止原始事件，让网站自身的 Enter 处理逻辑正常工作
      var sendBtn = findSendButton(target);
      if (!sendBtn) {
        console.log('[EnterSend] 未找到发送按钮，不拦截 Enter，交由网站处理');
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      console.log('[EnterSend] 拦截 Enter, 点击发送按钮:', sendBtn.tagName, 'class=', sendBtn.className);
      try {
        sendBtn.click();
        console.log('[EnterSend] 发送按钮 click() 调用完成');
      } catch (err) {
        console.error('[EnterSend] 点击发送按钮失败:', err);
      }
    }, true);
    console.log('[EnterSend] 监听器已注册');
  })()`;
}
