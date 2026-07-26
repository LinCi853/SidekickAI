// block-rules-default.ts — 预置页面组件屏蔽规则
//
// 按平台域名预置常见屏蔽规则，首次启动时填充。
// 内置规则不可删除，但可禁用。

import type { BlockRule } from '../shared/block-rules.types.js'

/** 预置屏蔽规则（id 使用固定值便于幂等填充） */
export const DEFAULT_BLOCK_RULES: BlockRule[] = [
  // ===== 通用规则（所有域名） =====
  {
    id: 'builtin-block-confirm-alert',
    domainPattern: '*',
    type: 'js',
    selector: '',
    jsCode: `window.confirm = function() { return true; }; window.alert = function() {}; window.prompt = function() { return null; };`,
    label: '屏蔽原生弹窗（confirm/alert/prompt）',
    enabled: true,
    builtin: true,
  },
  // 需求 8：通用侧边栏广告屏蔽（所有域名）
  {
    id: 'builtin-generic-sidebar-ads',
    domainPattern: '*',
    type: 'css',
    selector: '[class*="ad-banner"], [class*="ad-container"], [id*="ad-banner"], [class*="sidebar-ad"], [class*="ad-slot"], [id*="ad-container"]',
    label: '通用侧边栏广告屏蔽',
    enabled: true,
    builtin: true,
  },
  // 需求 8：通用升级/付费弹窗屏蔽（所有域名）
  {
    id: 'builtin-generic-upgrade-modal',
    domainPattern: '*',
    type: 'css',
    selector: '[class*="upgrade-modal"], [class*="pro-modal"], [class*="premium-banner"], [class*="upgrade-banner"], [class*="pro-banner"]',
    label: '通用升级/付费弹窗屏蔽',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin-block-beforeunload',
    domainPattern: '*',
    type: 'js',
    selector: '',
    // 屏蔽 beforeunload 弹窗：定时清空 onbeforeunload（网站可能动态设置此属性）
    // 注意：早期实现通过劫持 window.addEventListener 过滤 beforeunload 事件，
    // 但这种全局 API 劫持会干扰 DeepSeek 等 SPA 的内部 addEventListener 调用，
    // 导致鉴权/路由等监听器失效。改为只定时清空 onbeforeunload，更安全。
    jsCode: `(function() { window.onbeforeunload = null; if (!window.__ai_beforeunload_cleaner__) { window.__ai_beforeunload_cleaner__ = setInterval(function() { window.onbeforeunload = null; }, 2000); } })();`,
    label: '屏蔽离开页面提示',
    enabled: true,
    builtin: true,
  },
  // ===== ChatGPT =====
  {
    id: 'builtin-chatgpt-download',
    domainPattern: '*.chatgpt.com',
    type: 'css',
    selector: '[class*="download-app"], [class*="app-cta"], [data-testid="mobile-app-banner"]',
    label: 'ChatGPT 下载应用提示',
    enabled: true,
    builtin: true,
  },
  // ===== Claude =====
  {
    id: 'builtin-claude-upgrade',
    domainPattern: '*.claude.ai',
    type: 'css',
    selector: '[class*="upgrade-banner"], [class*="subscription-banner"]',
    label: 'Claude 订阅升级横幅',
    enabled: true,
    builtin: true,
  },
  // ===== DeepSeek =====
  {
    id: 'builtin-deepseek-download',
    domainPattern: '*.deepseek.com',
    type: 'css',
    // DeepSeek 下载应用按钮：精准匹配 ds-button--outlinedNeutral 包含"下载应用"的按钮及其外层容器
    // 用户提供的 HTML: <div class="_9579690"><div role="button" class="ds-button ds-button--outlinedNeutral...">下载应用</div></div>
    // 注意：a[href*="app"] 已移除——会误匹配 /applyAndLogin 等登录流程 URL，导致登录态丢失
    selector: '.ds-button--outlinedNeutral, [class*="_9579690"], [class*="download"], [class*="app-download"], [class*="app-banner"], [class*="qrcode"], a[href*="download"]',
    label: 'DeepSeek 下载按钮',
    enabled: true,
    builtin: true,
  },
  // DeepSeek 下载按钮 JS 规则：通过文本内容精准匹配"下载应用"按钮
  {
    id: 'builtin-deepseek-download-js',
    domainPattern: '*.deepseek.com',
    type: 'js',
    selector: '',
    jsCode: `(function() {
      // 隐藏包含"下载应用"文本的按钮及其父容器
      var buttons = document.querySelectorAll('.ds-button, [role="button"], button');
      buttons.forEach(function(btn) {
        var text = (btn.textContent || '').trim();
        if (text === '下载应用' || text === '下载DeepSeek' || text.indexOf('下载应用') >= 0) {
          // 向上查找包含容器并隐藏
          var el = btn;
          for (var i = 0; i < 5; i++) {
            if (!el || el === document.body) break;
            el = el.parentElement;
            if (el && el.offsetHeight < 200) {
              el.style.setProperty('display', 'none', 'important');
              break;
            }
          }
          btn.style.setProperty('display', 'none', 'important');
        }
      });
      // MutationObserver 动态清理
      if (!window.__ai_deepseek_block_observer__) {
        window.__ai_deepseek_block_observer__ = true;
        var observer = new MutationObserver(function() {
          document.querySelectorAll('.ds-button, [role="button"], button').forEach(function(btn) {
            var text = (btn.textContent || '').trim();
            if (text === '下载应用' || text.indexOf('下载应用') >= 0) {
              var el = btn;
              for (var i = 0; i < 5; i++) {
                if (!el || el === document.body) break;
                el = el.parentElement;
                if (el && el.offsetHeight < 200) {
                  el.style.setProperty('display', 'none', 'important');
                  break;
                }
              }
              btn.style.setProperty('display', 'none', 'important');
            }
          });
        });
        observer.observe(document.body, { childList: true, subtree: true });
      }
    })();`,
    label: 'DeepSeek 下载按钮（JS 文本匹配）',
    enabled: true,
    builtin: true,
  },
  // ===== 豆包 =====
  {
    id: 'builtin-doubao-download',
    domainPattern: '*.doubao.com',
    type: 'css',
    // 豆包下载提示：匹配 download/app-banner/qrcode 等 + href 链接
    // 注意：a[href*="/app"] 已收紧为 a[href*="/download/app"]——会误匹配登录流程 URL，
    // 导致登录态丢失。原 a[href*="/app"] 一次性迁移逻辑见 block-rules-store.ts ensureDefaultBlockRules()
    selector: '[class*="download" i], [class*="app-download" i], [class*="app-banner" i], [class*="qrcode" i], a[href*="/download"], a[href*="/download/app"]',
    label: '豆包下载提示',
    enabled: true,
    builtin: true,
  },
  // 豆包 JS 规则：通过文本匹配下载按钮/二维码容器
  {
    id: 'builtin-doubao-download-js',
    domainPattern: '*.doubao.com',
    type: 'js',
    selector: '',
    jsCode: `(function() {
      var keywords = ['下载豆包', '下载 App', '下载应用', '下载客户端', '扫码下载'];
      function hideIfMatch(el) {
        var text = (el.textContent || '').trim();
        if (text.length > 60) return false; // 只匹配短文本按钮/横幅
        for (var i = 0; i < keywords.length; i++) {
          if (text.indexOf(keywords[i]) >= 0) return true;
        }
        // 匹配包含下载链接且含二维码图片的容器
        // 注意：a[href*="/app"] 已收紧为 a[href*="/download/app"]——会误匹配登录流程 URL
        var imgs = el.querySelectorAll ? el.querySelectorAll('img[src*="qrcode"], img[src*="download"], canvas') : [];
        if (imgs.length > 0 && el.querySelectorAll('a[href*="/download"], a[href*="/download/app"]').length > 0) return true;
        return false;
      }
      function scan() {
        var candidates = document.querySelectorAll('[role="button"], button, a, div, span');
        candidates.forEach(function(el) {
          if (el.getAttribute('data-ai-blocked')) return;
          if (hideIfMatch(el)) {
            el.setAttribute('data-ai-blocked', '1');
            el.style.setProperty('display', 'none', 'important');
          }
        });
      }
      scan();
      if (!window.__ai_doubao_block_observer__) {
        window.__ai_doubao_block_observer__ = true;
        new MutationObserver(function() { scan(); }).observe(document.body, { childList: true, subtree: true });
      }
    })();`,
    label: '豆包下载提示（JS 文本匹配）',
    enabled: true,
    builtin: true,
  },
  // ===== Kimi（月之暗面） =====
  {
    id: 'builtin-kimi-download',
    domainPattern: '*.moonshot.cn',
    type: 'css',
    // Kimi 下载/二维码类元素：CSS Modules 哈希类名，用 i 忽略大小写 + href 稳定匹配
    selector: '[class*="download" i], [class*="app-download" i], [class*="app-banner" i], [class*="qrcode" i], a[href*="/download/app"], a[href*="/download"], a[href*="extension/download"]',
    label: 'Kimi 下载提示',
    enabled: true,
    builtin: true,
  },
  // Kimi JS 规则：通过文本匹配下载按钮
  {
    id: 'builtin-kimi-download-js',
    domainPattern: '*.moonshot.cn',
    type: 'js',
    selector: '',
    jsCode: `(function() {
      var keywords = ['下载 Kimi', '下载App', '下载 App', '下载应用', '下载客户端', '扫码下载', '安装插件'];
      function hideIfMatch(el) {
        var text = (el.textContent || '').trim();
        if (text.length > 60) return false;
        for (var i = 0; i < keywords.length; i++) {
          if (text.indexOf(keywords[i]) >= 0) return true;
        }
        return false;
      }
      function scan() {
        var candidates = document.querySelectorAll('[role="button"], button, a, div, span');
        candidates.forEach(function(el) {
          if (el.getAttribute('data-ai-blocked')) return;
          if (hideIfMatch(el)) {
            el.setAttribute('data-ai-blocked', '1');
            el.style.setProperty('display', 'none', 'important');
          }
        });
      }
      scan();
      if (!window.__ai_kimi_block_observer__) {
        window.__ai_kimi_block_observer__ = true;
        new MutationObserver(function() { scan(); }).observe(document.body, { childList: true, subtree: true });
      }
    })();`,
    label: 'Kimi 下载提示（JS 文本匹配）',
    enabled: true,
    builtin: true,
  },
  // ===== 智谱清言 =====
  {
    id: 'builtin-chatglm-download',
    domainPattern: '*.chatglm.cn',
    type: 'css',
    // 智谱清言下载/二维码类元素
    // 注意：a[href*="/app"] 已收紧为 a[href*="/download/app"]——会误匹配登录流程 URL
    selector: '[class*="download" i], [class*="app-banner" i], [class*="qrcode" i], a[href*="/download"], a[href*="/download/app"]',
    label: '智谱清言下载提示',
    enabled: false,
    builtin: true,
  },
  // 智谱清言 JS 规则
  {
    id: 'builtin-chatglm-download-js',
    domainPattern: '*.chatglm.cn',
    type: 'js',
    selector: '',
    jsCode: `(function() {
      var keywords = ['下载智谱', '下载App', '下载 App', '下载应用', '扫码下载'];
      function hideIfMatch(el) {
        var text = (el.textContent || '').trim();
        if (text.length > 60) return false;
        for (var i = 0; i < keywords.length; i++) {
          if (text.indexOf(keywords[i]) >= 0) return true;
        }
        return false;
      }
      function scan() {
        document.querySelectorAll('[role="button"], button, a, div, span').forEach(function(el) {
          if (el.getAttribute('data-ai-blocked')) return;
          if (hideIfMatch(el)) {
            el.setAttribute('data-ai-blocked', '1');
            el.style.setProperty('display', 'none', 'important');
          }
        });
      }
      scan();
      if (!window.__ai_chatglm_block_observer__) {
        window.__ai_chatglm_block_observer__ = true;
        new MutationObserver(function() { scan(); }).observe(document.body, { childList: true, subtree: true });
      }
    })();`,
    label: '智谱清言下载提示（JS 文本匹配）',
    enabled: false,
    builtin: true,
  },
  // ===== Gemini =====
  // Gemini 升级到 Advanced 横幅 + 登录引导弹窗
  {
    id: 'builtin-gemini-upgrade',
    domainPattern: '*.gemini.google.com',
    type: 'css',
    // Gemini 升级到 Advanced 横幅、试用提示等
    selector: '[class*="upgrade" i], [class*="advanced-banner" i], [class*="subscription-banner" i], [class*="try-advanced" i], [data-testid*="upgrade"]',
    label: 'Gemini 升级横幅',
    enabled: true,
    builtin: true,
  },
  // ===== 文心一言 =====
  // 文心一言下载 App 提示 + 升级提示
  {
    id: 'builtin-yiyan-download',
    domainPattern: '*.yiyan.baidu.com',
    type: 'css',
    // 注意：a[href*="/app"] 不加入——避免误匹配百度登录回调 URL
    selector: '[class*="download" i], [class*="app-download" i], [class*="app-banner" i], [class*="qrcode" i], a[href*="/download"], a[href*="/download/app"]',
    label: '文心一言下载提示',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin-yiyan-download-js',
    domainPattern: '*.yiyan.baidu.com',
    type: 'js',
    selector: '',
    jsCode: `(function() {
      var keywords = ['下载文心', '下载 App', '下载应用', '下载客户端', '扫码下载', '安装文心一言'];
      function hideIfMatch(el) {
        var text = (el.textContent || '').trim();
        if (text.length > 60) return false;
        for (var i = 0; i < keywords.length; i++) {
          if (text.indexOf(keywords[i]) >= 0) return true;
        }
        return false;
      }
      function scan() {
        document.querySelectorAll('[role="button"], button, a, div, span').forEach(function(el) {
          if (el.getAttribute('data-ai-blocked')) return;
          if (hideIfMatch(el)) {
            el.setAttribute('data-ai-blocked', '1');
            el.style.setProperty('display', 'none', 'important');
          }
        });
      }
      scan();
      if (!window.__ai_yiyan_block_observer__) {
        window.__ai_yiyan_block_observer__ = true;
        new MutationObserver(function() { scan(); }).observe(document.body, { childList: true, subtree: true });
      }
    })();`,
    label: '文心一言下载提示（JS 文本匹配）',
    enabled: true,
    builtin: true,
  },
  // ===== 小米 Mimo =====
  // 小米 Mimo 引导跳转到 aistudio.xiaomimimo.com 的横幅 + 下载 App 提示
  {
    id: 'builtin-mimo-redirect',
    domainPattern: '*.xiaomi.com',
    type: 'css',
    // 小米 Mimo 引导跳转 aistudio 的横幅、下载提示等
    // 注意：a[href*="xiaomimimo.com"] 不加入——会误屏蔽合法跳转，改由 allowedOrigins 处理
    selector: '[class*="download" i], [class*="app-download" i], [class*="app-banner" i], [class*="qrcode" i], a[href*="/download"], a[href*="/download/app"]',
    label: '小米 Mimo 下载提示',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin-mimo-redirect-js',
    domainPattern: '*.xiaomi.com',
    type: 'js',
    selector: '',
    jsCode: `(function() {
      var keywords = ['下载 Mimo', '下载App', '下载 App', '下载应用', '扫码下载', '下载客户端'];
      function hideIfMatch(el) {
        var text = (el.textContent || '').trim();
        if (text.length > 60) return false;
        for (var i = 0; i < keywords.length; i++) {
          if (text.indexOf(keywords[i]) >= 0) return true;
        }
        return false;
      }
      function scan() {
        document.querySelectorAll('[role="button"], button, a, div, span').forEach(function(el) {
          if (el.getAttribute('data-ai-blocked')) return;
          if (hideIfMatch(el)) {
            el.setAttribute('data-ai-blocked', '1');
            el.style.setProperty('display', 'none', 'important');
          }
        });
      }
      scan();
      if (!window.__ai_mimo_block_observer__) {
        window.__ai_mimo_block_observer__ = true;
        new MutationObserver(function() { scan(); }).observe(document.body, { childList: true, subtree: true });
      }
    })();`,
    label: '小米 Mimo 下载提示（JS 文本匹配）',
    enabled: true,
    builtin: true,
  },
]
