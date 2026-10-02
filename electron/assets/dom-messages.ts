import { classifyCapturedNoise } from './noise-classifier.js'
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

export interface DomConversation {
  messages: DomMessage[]
  rejected: Array<{ key: string; reason: string; content: string }>
  completePath: boolean
}
const interfaceSelector = 'nav, aside, [role="menu"], [role="navigation"], [data-account-menu], [data-login-panel], [data-testid*="account-menu"], [data-testid*="login"], [class*="account-menu"], [class*="login-panel"]'
const chromeSelector = `${interfaceSelector}, button, svg, script, style, [aria-hidden="true"], .copy-button, .message-toolbar, [data-testid*="message-actions"], [data-branch-controls]`

function markdown(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? ''
  if (!(node instanceof Element) || node.matches(chromeSelector)) return ''
  const text = Array.from(node.childNodes).map(markdown).join('')
  const tag = node.tagName
  if (tag === 'TABLE') {
    const rows = Array.from(node.querySelectorAll('tr')).map(row => Array.from(row.children)
      .filter(cell => cell.matches('td, th')).map(cell => markdown(cell).trim().replaceAll('|', '\\|').replaceAll('\n', '<br>')))
    if (!rows.length) return ''
    const width = Math.max(...rows.map(row => row.length))
    const line = (row: string[]) => '| ' + Array.from({ length: width }, (_, index) => row[index] ?? '').join(' | ') + ' |'
    return '\n\n' + [line(rows[0]), line(Array.from({ length: width }, () => '---')), ...rows.slice(1).map(line)].join('\n') + '\n\n'
  }
  if (tag === 'BR') return '\n'
  if (tag === 'PRE') {
    const code = node.querySelector('code')
    const language = code?.className.match(/language-([\w+-]+)/)?.[1] ?? ''
    const content = code?.textContent ?? node.textContent ?? ''
    const fence = '`'.repeat(Math.max(3, ...(content.match(/`+/g) ?? []).map(value => value.length + 1)))
    return `\n${fence}${language}\n${content}\n${fence}\n`
  }
  if (tag === 'CODE') return `\`${text}\``
  if (tag === 'STRONG' || tag === 'B') return `**${text}**`
  if (tag === 'EM' || tag === 'I') return `*${text}*`
  if (tag === 'A') {
    const href = node.getAttribute('href') ?? ''
    return /^https?:/i.test(href) ? `[${text}](${href.replace(/[()]/g, value => encodeURIComponent(value))})` : text
  }
  if (/^H[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${text}\n\n`
  if (tag === 'LI') {
    const index = Array.from(node.parentElement?.children ?? []).indexOf(node) + 1
    return `${node.parentElement?.tagName === 'OL' ? `${index}.` : '-'} ${text.trim()}\n`
  }
  if (tag === 'BLOCKQUOTE') return text.trim().split('\n').map(line => `> ${line}`).join('\n') + '\n\n'
  return text + (blocks.has(tag) && text ? '\n\n' : '')
}
function branchIdentity(element: Element): { branchIndex?: number; branchCount?: number; versionKey?: string } {
  const host = element.closest('[data-message-id], [data-message-container]') ?? element
  let index = Number(element.getAttribute('data-branch-index') || host.getAttribute('data-branch-index'))
  let count = Number(element.getAttribute('data-branch-count') || host.getAttribute('data-branch-count'))
  if (!index || !count) {
    const controls = host.querySelector('[data-branch-controls], [aria-label*="版本"], [aria-label*="branch"], [class*="branch-control"], [class*="message-actions"], .message-toolbar')
    const counter = controls?.textContent?.match(/(?:^|\s)(\d+)\s*\/\s*(\d+)(?:\s|$)/)
    if (counter) { index = Number(counter[1]); count = Number(counter[2]) }
  }
  const versionKey = element.getAttribute('data-version-id') || host.getAttribute('data-version-id') || undefined
  return index >= 1 && count >= index && count <= 10000
    ? { branchIndex: index, branchCount: count, versionKey: versionKey ?? (count > 1 ? String(index) : undefined) }
    : { versionKey }
}
export function readDomConversation(document: Document, hostname: string): DomConversation {
  const selectors = platforms[hostname] ?? fallback
  const candidates = selectors.map((selector, role) => {
    let nodes = Array.from(document.querySelectorAll(selector))
    if (!nodes.length) nodes = Array.from(document.querySelectorAll(fallback[role]))
    return nodes.filter(node => !nodes.some(other => other !== node && other.contains(node)))
  })
  const messages: DomMessage[] = []
  const rejected: DomConversation['rejected'] = []
  candidates.forEach((nodes, roleIndex) => {
    const role = roleIndex === 0 ? 'user' : 'assistant'
    nodes.forEach((element, index) => {
      const external = element.getAttribute('data-message-id') || element.getAttribute('data-id') || element.id
      const key = `${role}:${external || index}`
      const excluded = element.closest(interfaceSelector)
      const loginForm = element.closest('form')?.querySelector('input[type="password"], input[autocomplete="one-time-code"]')
      if (excluded || loginForm) {
        rejected.push({ key, reason: loginForm ? 'login-interface' : 'interface-container', content: nodeText(element) }); return
      }
      const thinking = Array.from(element.querySelectorAll(thinkingSelector))
        .filter(node => !node.parentElement?.closest(thinkingSelector))
      for (const fragment of Array.from(element.querySelectorAll(interfaceSelector))) {
        if (fragment.parentElement?.closest(interfaceSelector)) continue
        rejected.push({ key: `${key}:interface`, reason: 'interface-container', content: nodeText(fragment) })
      }
      const clone = element.cloneNode(true) as Element
      clone.querySelectorAll(`${thinkingSelector}, ${chromeSelector}`).forEach(node => node.remove())
      const content = nodeText(clone).replace(/\n$/, '')
      const noise = classifyCapturedNoise(content)
      if (noise && noise !== 'empty-capture') { rejected.push({ key, reason: noise, content }); return }
      const reasoning = thinking.map(node => nodeText(node).replace(/\n$/, '')).join('\n')
      const explicitStatus = element.getAttribute('data-status')
      const streaming = element.matches('[aria-busy="true"], [data-streaming="true"], [data-is-streaming="true"]')
        || !!element.querySelector('[aria-busy="true"], [data-streaming="true"]')
        || (role === 'assistant' && index === nodes.length - 1 && !!document.querySelector(
          'button[aria-label*="Stop"], button[aria-label*="停止"], button[data-testid="stop-button"]'))
      const status = explicitStatus === 'withdrawn' || explicitStatus === 'stopped' || explicitStatus === 'failed' || explicitStatus === 'streaming'
        ? explicitStatus : streaming ? 'streaming' : 'complete'
      if (!content.trim() && !reasoning.trim() && status === 'complete') return
      messages.push({ element, observed: { key, role, content, markdownContent: markdown(clone).trim(),
        ...(thinking.length ? { reasoning } : {}), ...branchIdentity(element), status } })
    })
  })
  messages.sort((a, b) => a.element.compareDocumentPosition(b.element) & 2 ? 1 : -1)
  const first = messages[0]?.element
  const completePath = !document.querySelector('[data-virtualized="true"], [data-messages-partial="true"]')
    && !(first && Number(first.getAttribute('aria-posinset')) > 1)
  return { messages, rejected, completePath }
}
export function readDomMessages(document: Document, hostname: string): DomMessage[] {
  return readDomConversation(document, hostname).messages
}
