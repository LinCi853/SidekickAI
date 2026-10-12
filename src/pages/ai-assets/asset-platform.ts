// pages/ai-assets/asset-platform.ts —— 对话来源的展示名与标题整理
// 列表条目不再直接显示网址主机名：已知域名映射为平台名，未知域名才回退主机名；
// 收录时带入的「 - 平台名」标题后缀在展示层去除，存储标题保持不变。

import type { Conversation } from '../../lib/electron-api';

const PLATFORM_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['chat.deepseek.com', 'DeepSeek'],
  ['deepseek.com', 'DeepSeek'],
  ['aistudio.xiaomimimo.com', 'MiMo'],
  ['xiaomimimo.com', 'MiMo'],
  ['kimi.moonshot.cn', 'Kimi'],
  ['kimi.com', 'Kimi'],
  ['moonshot.cn', 'Kimi'],
  ['doubao.com', '豆包'],
  ['www.doubao.com', '豆包'],
  ['chatglm.cn', '智谱清言'],
  ['chatgpt.com', 'ChatGPT'],
  ['claude.ai', 'Claude'],
  ['gemini.google.com', 'Gemini'],
  ['chat.qwen.ai', '千问'],
  ['tongyi.aliyun.com', '通义千问'],
  ['yiyan.baidu.com', '文心一言'],
];

function hostnamePlatform(hostname: string): string | undefined {
  const host = hostname.replace(/^www\./, '').toLowerCase();
  const exact = PLATFORM_NAMES.find(([domain]) => host === domain);
  if (exact) return exact[1];
  const parent = PLATFORM_NAMES.find(([domain]) => host.endsWith(`.${domain}`));
  return parent?.[1];
}

/** 对话来源的展示名：API 收录显示 API，已知域名显示平台名，未知域名回退主机名 */
export function conversationPlatform(conversation: Conversation): string {
  if (conversation.sourceType === 'api') return 'API';
  try {
    if (!conversation.url) return '网页';
    return hostnamePlatform(new URL(conversation.url).hostname) ?? new URL(conversation.url).hostname.replace(/^www\./, '');
  } catch { return '网页'; }
}

/** 展示用标题：去掉与来源平台重复的「 - 平台名」「 ｜ 平台名」结尾，存储标题不变 */
export function displayConversationTitle(conversation: Conversation): string {
  const title = conversation.title || '未命名对话';
  const platform = conversationPlatform(conversation);
  if (platform === 'API' || platform === '网页') return title;
  for (const separator of [' - ', ' ｜ ']) {
    const suffix = separator + platform;
    if (title.length > suffix.length && title.toLowerCase().endsWith(suffix.toLowerCase())) {
      return title.slice(0, title.length - suffix.length).trimEnd() || title;
    }
  }
  return title;
}

/** 消息头的应用标识：显示对话所属 AI 应用，未知来源回退「AI应用」 */
export function conversationAiLabel(conversation: Conversation): string {
  const platform = conversationPlatform(conversation);
  return platform === '网页' ? 'AI应用' : platform;
}
