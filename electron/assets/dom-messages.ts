import type { AssetObservedMessage } from '../shared/ai-assets.types.js'

const platforms: Record<string, [string, string]> = {
  'chatgpt.com': ['[data-message-author-role="user"]', '[data-message-author-role="assistant"]'],
  'claude.ai': ['[data-testid="user-message"]', '[data-testid="ai-response"], [data-testid="assistant-message"], .font-claude-message'],
  'gemini.google.com': ['.query-text, [data-test-id="user-query"], .query-content', '.response-container, .model-response-text'],
  'doubao.com': ['[data-testid="user_message"], [data-testid="user-message"]', '[data-testid="assistant_message"], [data-testid="assistant-message"], .receive-message'],
  'chatglm.cn': ['.chat-item-user, [class*="user-message"]', '.chat-item-ai, .chat-item-assistant, [class*="ai-message"]'],
  'chat.deepseek.com': ['.ds-message--user, [class*="ds-message"][class*="user"]', '.ds-message--assistant, [class*="ds-message"][class*="assistant"]'],
  'kimi.moonshot.cn': ['.message-block.user, .user-message', '.message-block.assistant, .ai-message'],
  'kimi.com': ['.message-block.user, .user-message', '.message-block.assistant, .ai-message'],
  'yiyan.baidu.com': ['.user-question, .user-msg', '.answer-content, .answer-message'],
  'mimo.xiaomi.com': ['.user-msg, .user-message', '.ai-msg, .ai-message'],
}
const fallback: [string, string] = [
  '[data-message-author-role="user"], [data-testid="user-message"], [data-role="user"], .user-message',
  '[data-message-author-role="assistant"], [data-testid="assistant-message"], [data-role="assistant"], .assistant-message',
]
const thinkingSelector = '[data-testid*="thinking"], [data-testid*="reasoning"], [data-thinking], .thinking-content, [class*="reasoning-content"]'
const blocks = new Set(['P', 'DIV', 'PRE', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'TR'])

function nodeText(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? ''
  if (!(node instanceof Element)) return ''
  if (node.matches('button, svg, script, style, [aria-hidden="true"], .copy-button, .message-toolbar')) return ''
  if (node.tagName === 'BR') return '\n'
  if (node.tagName === 'PRE') return (node.textContent ?? '') + '\n'
  const text = Array.from(node.childNodes).map(nodeText).join('')
  return text + (blocks.has(node.tagName) && text && !text.endsWith('\n') ? '\n' : '')
}

export interface DomMessage {
  element: Element
  observed: AssetObservedMessage
}

export function readDomMessages(document: Document, hostname: string): DomMessage[] {
  const selectors = platforms[hostname] ?? fallback
  const candidates = selectors.map(selector => {
    let nodes = Array.from(document.querySelectorAll(selector))
    if (!nodes.length) nodes = Array.from(document.querySelectorAll(fallback[selectors.indexOf(selector)]))
    return nodes.filter(node => !nodes.some(other => other !== node && other.contains(node)))
  })
  const result: DomMessage[] = []
  candidates.forEach((nodes, roleIndex) => {
    const role = roleIndex === 0 ? 'user' : 'assistant'
    nodes.forEach((element, index) => {
      const thinking = Array.from(element.querySelectorAll(thinkingSelector))
        .filter(node => !node.parentElement?.closest(thinkingSelector))
      const clone = element.cloneNode(true) as Element
      clone.querySelectorAll(thinkingSelector).forEach(node => node.remove())
      const content = nodeText(clone).replace(/\n$/, '')
      const reasoning = thinking.map(node => nodeText(node).replace(/\n$/, '')).join('\n')
      const external = element.getAttribute('data-message-id') || element.getAttribute('data-id') || element.id
      const streaming = element.matches('[aria-busy="true"], [data-streaming="true"], [data-is-streaming="true"]')
        || !!element.querySelector('[aria-busy="true"], [data-streaming="true"]')
        || (role === 'assistant' && index === nodes.length - 1 && !!document.querySelector(
          'button[aria-label*="Stop"], button[aria-label*="停止"], button[data-testid="stop-button"]'))
      result.push({ element, observed: { key: `${role}:${external || index}`, role, content,
        ...(thinking.length ? { reasoning } : {}), status: streaming ? 'streaming' : 'complete' } })
    })
  })
  return result.sort((a, b) => a.element.compareDocumentPosition(b.element) & 2 ? 1 : -1)
}
