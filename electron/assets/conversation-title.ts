// 对话名整理：部分 SPA（智谱清言等）从不随会话更新 document.title，整站固定为平台名。
// 这类标题观察时视为「没有名字」，由首条用户消息推导展示名，避免整个列表同名。

const platformDefaultTitles: Readonly<Record<string, string>> = {
  'chatglm.cn': '智谱清言',
  'chat.deepseek.com': 'DeepSeek',
  'kimi.moonshot.cn': 'Kimi',
  'kimi.com': 'Kimi',
  'aistudio.xiaomimimo.com': 'MiMo',
  'mimo.xiaomi.com': 'MiMo',
  'doubao.com': '豆包',
  'chatgpt.com': 'ChatGPT',
  'claude.ai': 'Claude',
  'gemini.google.com': 'Gemini',
  'chat.qwen.ai': '千问',
  'tongyi.aliyun.com': '通义千问',
  'yiyan.baidu.com': '文心一言',
  'wenxin.baidu.com': '文心一言',
  'yuanbao.tencent.com': '腾讯元宝',
}

export function normalizeWebHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '')
}

/** document.title 是否为平台固定名（「平台名」「平台名 - 副标题」），不能当作对话名 */
export function isPlatformDefaultTitle(hostname: string, documentTitle: string): boolean {
  const raw = documentTitle.trim()
  if (!raw) return true
  const name = platformDefaultTitles[normalizeWebHostname(hostname)]
  if (!name) return false
  const lead = raw.split(/\s*[-–—|｜·]\s*/)[0].trim()
  return !lead || lead === name
}

/** 从首条用户消息推导对话名：取第一个非空行，去掉 Markdown 前缀记号，最多 48 字 */
export function titleFromMessageContent(content: string): string {
  for (const line of content.split('\n')) {
    const text = line.replace(/^\s*(?:[#>]+|[-*+]|\d+[.)])\s*/, '').trim()
    if (text) return Array.from(text).slice(0, 48).join('')
  }
  return ''
}
