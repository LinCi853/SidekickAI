// electron/store/block-rules-preset.ts — 预置屏蔽规则数据
//
// 从 default-config.ts 拆出的纯数据文件：预置屏蔽规则（id 使用固定值便于幂等填充）。
// 仍经由 default-config.ts 路由导出，消费方导入路径不变。
//
// 现阶段只保留「基础且百分百是广告」的类名/ID 选择器。
// 各 AI 应用的下载横幅、扫码区等后续按应用单独适配，不再用宽泛选择器一刀切
// （此前 [class*="qrcode"] 等会误伤登录二维码）。

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
    id: 'builtin-block-beforeunload',
    domainPattern: '*',
    type: 'js',
    selector: '',
    jsCode: `(function() { window.onbeforeunload = null; if (!window.__ai_beforeunload_cleaner__) { window.__ai_beforeunload_cleaner__ = setInterval(function() { window.onbeforeunload = null; }, 2000); } })();`,
    label: '屏蔽离开页面提示',
    enabled: true,
    builtin: true,
  },
]

/** 历史预置中会误伤登录/下载 UI 的内置规则 id（迁移时强制关闭，后续按 AI 应用单独适配） */
export const RETIRED_BUILTIN_RULE_IDS: string[] = [
  'builtin-generic-upgrade-modal',
  'builtin-chatgpt-download',
  'builtin-claude-upgrade',
  'builtin-deepseek-download',
  'builtin-deepseek-download-js',
  'builtin-doubao-download',
  'builtin-doubao-download-js',
  'builtin-kimi-download',
  'builtin-kimi-download-js',
  'builtin-chatglm-download',
  'builtin-chatglm-download-js',
  'builtin-gemini-upgrade',
  'builtin-yiyan-download',
  'builtin-yiyan-download-js',
  'builtin-mimo-redirect',
  'builtin-mimo-redirect-js',
]
