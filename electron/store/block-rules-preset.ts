// electron/store/block-rules-preset.ts — 预置屏蔽规则数据
//
// 从 default-config.ts 拆出的纯数据文件：预置屏蔽规则（id 使用固定值便于幂等填充）。
// 仍经由 default-config.ts 路由导出，消费方导入路径不变。

import type { BlockRule } from '../shared/block-rules.types.js'

export const BLOCK_RULES: BlockRule[] = [
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
  {
    id: 'builtin-generic-sidebar-ads',
    domainPattern: '*',
    type: 'css',
    selector: '[class*="ad-banner"], [class*="ad-container"], [id*="ad-banner"], [class*="sidebar-ad"], [class*="ad-slot"], [id*="ad-container"]',
    label: '通用侧边栏广告屏蔽',
    enabled: true,
    builtin: true,
  },
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
    selector: '[class*="_9579690"], [class*="download"], [class*="app-download"], [class*="app-banner"], [class*="qrcode"], a[href*="download"]',
    label: 'DeepSeek 下载按钮',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin-deepseek-download-js',
    domainPattern: '*.deepseek.com',
    type: 'js',
    selector: '',
    jsCode: `(function() {
      var buttons = document.querySelectorAll('.ds-button, [role="button"], button');
      buttons.forEach(function(btn) {
        var text = (btn.textContent || '').trim();
        if (text === '下载应用' || text === '下载DeepSeek' || text.indexOf('下载应用') >= 0) {
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
    selector: '[class*="download" i], [class*="app-download" i], [class*="app-banner" i], [class*="qrcode" i], a[href*="/download"], a[href*="/download/app"]',
    label: '豆包下载提示',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin-doubao-download-js',
    domainPattern: '*.doubao.com',
    type: 'js',
    selector: '',
    jsCode: `(function() {
      var keywords = ['下载豆包', '下载 App', '下载应用', '下载客户端', '扫码下载'];
      function hideIfMatch(el) {
        var text = (el.textContent || '').trim();
        if (text.length > 60) return false;
        for (var i = 0; i < keywords.length; i++) {
          if (text.indexOf(keywords[i]) >= 0) return true;
        }
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
    selector: '[class*="download" i], [class*="app-download" i], [class*="app-banner" i], [class*="qrcode" i], a[href*="/download/app"], a[href*="/download"], a[href*="extension/download"]',
    label: 'Kimi 下载提示',
    enabled: true,
    builtin: true,
  },
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
    selector: '[class*="download" i], [class*="app-banner" i], [class*="qrcode" i], a[href*="/download"], a[href*="/download/app"]',
    label: '智谱清言下载提示',
    enabled: false,
    builtin: true,
  },
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
  {
    id: 'builtin-gemini-upgrade',
    domainPattern: '*.gemini.google.com',
    type: 'css',
    selector: '[class*="upgrade" i], [class*="advanced-banner" i], [class*="subscription-banner" i], [class*="try-advanced" i], [data-testid*="upgrade"]',
    label: 'Gemini 升级横幅',
    enabled: true,
    builtin: true,
  },
  // ===== 文心一言 =====
  {
    id: 'builtin-yiyan-download',
    domainPattern: '*.yiyan.baidu.com',
    type: 'css',
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
  {
    id: 'builtin-mimo-redirect',
    domainPattern: '*.xiaomi.com',
    type: 'css',
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
