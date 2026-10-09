import { classifyCapturedNoise } from './noise-classifier.js'
import type { AssetObservedMessage } from '../shared/ai-assets.types.js'

const mimoUserSelector = '.bg-mimo-bg-message.whitespace-pre-wrap'
const mimoMarkdownSelector = '[class*="Markdown_markdown__"]'
const platforms: Record<string, [string, string]> = {
  'chatgpt.com': ['[data-message-author-role="user"]', '[data-message-author-role="assistant"]'],
  'claude.ai': ['[data-testid="user-message"]', '[data-testid="ai-response"], [data-testid="assistant-message"], .font-claude-message'],
  'gemini.google.com': ['.query-text, [data-test-id="user-query"], .query-content', '.response-container, .model-response-text'],
  'doubao.com': ['[data-testid="user_message"], [data-testid="user-message"], [data-testid="message_content"].justify-end', '[data-testid="assistant_message"], [data-testid="assistant-message"], .receive-message, [data-testid="message_content"]:not(.justify-end)'],
  'chatglm.cn': ['.chat-item-user, [class*="user-message"], .conversation.question[id^="row-question-"]', '.chat-item-ai, .chat-item-assistant, [class*="ai-message"], .answer[id^="row-answer-"]'],
  'chat.deepseek.com': ['.ds-message--user, [class*="ds-message"][class*="user"]', '.ds-message--assistant, [class*="ds-message"][class*="assistant"]'],
  'kimi.moonshot.cn': ['.message-block.user, .user-message, .segment.segment-user', '.message-block.assistant, .ai-message, .segment.segment-assistant'],
  'kimi.com': ['.message-block.user, .user-message, .segment.segment-user', '.message-block.assistant, .ai-message, .segment.segment-assistant'],
  'yiyan.baidu.com': ['.user-question, .user-msg', '.answer-content, .answer-message'],
  'mimo.xiaomi.com': ['.user-msg, .user-message', '.ai-msg, .ai-message'],
  'aistudio.xiaomimimo.com': [mimoUserSelector, mimoMarkdownSelector],
  'qianwen.com': ['.chat-question-wrap', '[data-chat-answers-wrap]'],
  'wenxin.baidu.com': ['.cs-rank[data-query][rank]', '.answer-box[data-base-data], .history-answer-box[data-base-data]'],
}
const fallback: [string, string] = [
  '[data-message-author-role="user"], [data-testid="user-message"], [data-role="user"], .user-message',
  '[data-message-author-role="assistant"], [data-testid="assistant-message"], [data-role="assistant"], .assistant-message',
]
const thinkingSelector = '[data-testid*="thinking"], [data-testid*="reasoning"], [data-thinking], .thinking-content, [class*="reasoning-content"]'
const deepseekUserSelector = '.ds-message.d29f3d7d'
const deepseekUserContentSelector = '.fbb737a4'
const deepseekAnswerSelector = '.ds-assistant-message-main-content'
const deepseekThinkingSelector = '.ds-think-content'
const deepseekAssistantSelector = `${deepseekAnswerSelector}, ${deepseekThinkingSelector}`
const mimoThinkingSelector = '.mb-2:has([class*="Collapsible_Text__"] summary):not(:has(.mb-2 [class*="Collapsible_Text__"] summary))'
const qianwenThinkingSelector = '[data-card_name="deep_think"]'
const kimiThinkingSelector = '.thinking-container'
const wenxinThinkingSelector = '[class*="_thinking-steps_"]'
const platformThinkingSelectors: Record<string, string> = {
  'chat.deepseek.com': deepseekThinkingSelector,
  'aistudio.xiaomimimo.com': mimoThinkingSelector,
  'qianwen.com': qianwenThinkingSelector,
  'doubao.com': '[data-testid="preamble-elapsed"], [data-thinking-box]',
  'kimi.com': kimiThinkingSelector,
  'kimi.moonshot.cn': kimiThinkingSelector,
  'wenxin.baidu.com': wenxinThinkingSelector,
}
const blocks = new Set(['P', 'DIV', 'PRE', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'TR'])

function stripCodeToolbars(root: Element) {
  for (const pre of root.querySelectorAll('pre')) {
    const header = pre.previousElementSibling
    if (!header || header.querySelector('pre, code, p, a')) continue
    const words = (header.textContent ?? '').trim().match(/^([a-z][\w+#.-]{0,23})\s*(?:复制|Copy)\s*(?:下载|Download)\s*(?:运行|Run)?$/i)
    if (!words) continue
    pre.setAttribute('data-captured-language', words[1].toLowerCase())
    header.remove()
  }
}

function cloneMiMoAnswer(element: Element): Element {
  const clone = element.ownerDocument.createElement('div')
  const roots = element.matches(mimoMarkdownSelector)
    ? [element]
    : Array.from(element.querySelectorAll(mimoMarkdownSelector)).filter(block => !block.parentElement?.closest(mimoMarkdownSelector))
  for (const block of roots) {
    clone.appendChild(block.cloneNode(true))
  }
  for (const pre of clone.querySelectorAll('pre')) {
    const language = pre.querySelector('.languageLabel')?.textContent?.trim()
    if (language) pre.setAttribute('data-captured-language', language)
    pre.querySelectorAll('.languageLabel').forEach(label => label.remove())
    pre.closest('.relative.my-2.overflow-clip')?.querySelector('header')?.remove()
  }
  return clone
}

function nodeText(node: Node, visibleOnly = false): string {
  if (node.nodeType === 3) return node.textContent ?? ''
  if (!(node instanceof Element)) return ''
  if (visibleOnly && (node.closest('[hidden], [aria-hidden="true"], [inert]')
    || !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))) return ''
  if (node.matches('button, svg, script, style, [aria-hidden="true"], .copy-button, .message-toolbar')) return ''
  if (node.tagName === 'BR') return '\n'
  if (node.tagName === 'PRE' && !visibleOnly) return (node.textContent ?? '') + '\n'
  const text = Array.from(node.childNodes).map(child => nodeText(child, visibleOnly)).join('')
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
interface MiMoIdentity { key: string; token: string }
interface MiMoIdentityState { route: string; elements: WeakMap<Element, MiMoIdentity> }
const mimoIdentityStates = new WeakMap<Document, MiMoIdentityState>()

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
    const language = code?.className.match(/language-([\w+-]+)/)?.[1] ?? node.getAttribute('data-captured-language') ?? ''
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

function mimoTurnKeys(document: Document): Map<Element, MiMoIdentity> {
  const route = new URL(document.URL).hash.split('?')[0]
  let state = mimoIdentityStates.get(document)
  if (!state || (state.route !== route && /^#\/(?:chat|ultra)\//.test(state.route))) {
    state = { route, elements: new WeakMap() }
    mimoIdentityStates.set(document, state)
  }
  state.route = route
  const keys = new Map<Element, MiMoIdentity>()
  const groups = new Map<string, Element[]>()
  const occupied = new Set<string>()
  for (const bubble of Array.from(document.querySelectorAll(mimoUserSelector)).filter(bubble => !bubble.closest(interfaceSelector))) {
    const known = state.elements.get(bubble)
    if (known) occupied.add(known.key)
    const text = nodeText(bubble)
    let hash = 0xcbf29ce484222325n
    for (const character of text) hash = BigInt.asUintN(64, (hash ^ BigInt(character.codePointAt(0)!)) * 0x100000001b3n)
    const signature = hash.toString(16)
    const group = groups.get(signature) ?? []
    group.push(bubble); groups.set(signature, group)
  }
  for (const [signature, bubbles] of groups) {
    for (const bubble of bubbles) {
      let identity = state.elements.get(bubble)
      const key = `mimo:${signature}:0`
      if (!identity && bubbles.length === 1 && !occupied.has(key)) {
        identity = { key, token: crypto.randomUUID() }
        state.elements.set(bubble, identity)
        occupied.add(key)
      }
      if (identity) keys.set(bubble, identity)
    }
  }
  return keys
}

function wenxinRoundKey(element: Element): string | undefined {
  const host = element.closest('.cs-rank-container') ?? element
  const answer = host.querySelector('[data-base-data]') ?? element
  try {
    const metadata = JSON.parse(answer.getAttribute('data-base-data') ?? '{}')
    return typeof metadata.lid === 'string' || typeof metadata.lid === 'number' ? String(metadata.lid) : undefined
  } catch { return undefined }
}

function reasoningFragments(element: Element, selector: string, chrome: string): string[] {
  const clone = element.cloneNode(true) as Element
  clone.querySelectorAll(chrome).forEach(fragment => fragment.remove())
  const fragments = Array.from(clone.querySelectorAll(selector))
  return fragments.filter(fragment => !fragments.some(other => other !== fragment && other.contains(fragment)))
    .map(fragment => nodeText(fragment).replace(/\n$/, ''))
}

export function readDomConversation(document: Document, hostname: string): DomConversation {
  hostname = hostname.toLowerCase().replace(/^www\./, '')
  const deepseek = hostname === 'chat.deepseek.com'
  const mimo = hostname === 'aistudio.xiaomimimo.com'
  const qianwen = hostname === 'qianwen.com'
  const chatglm = hostname === 'chatglm.cn'
  const kimi = hostname === 'kimi.com' || hostname === 'kimi.moonshot.cn'
  const wenxin = hostname === 'wenxin.baidu.com'
  const messageThinkingSelector = [thinkingSelector, platformThinkingSelectors[hostname]].filter(Boolean).join(', ')
  const messageChromeSelector = `${chromeSelector}${chatglm ? ', .user-name, .assistant-name, .copy-btn, .advance-thinking-status, .advance-thinking-done, .thinking-done' : ''}${kimi ? ', .segment-avatar, .mobile-segment-avatar, .segment-user-actions, .segment-assistant-actions, .segment-user-goal-label' : ''}`
  const mimoKeys = mimo ? mimoTurnKeys(document) : undefined
  const selectors = platforms[hostname] ?? fallback
  const candidates = selectors.map((selector, role) => {
    let nodes = Array.from(document.querySelectorAll(selector))
    if (!nodes.length) nodes = Array.from(document.querySelectorAll(fallback[role]))
    if (deepseek) {
      const current = role === 0
        ? Array.from(document.querySelectorAll(deepseekUserSelector)).filter(node =>
          node.querySelector(deepseekUserContentSelector) && !node.querySelector(deepseekAssistantSelector))
        : Array.from(document.querySelectorAll(deepseekAssistantSelector))
          .map(node => node.closest('.ds-message')).filter((node): node is Element => !!node)
      nodes = Array.from(new Set([...nodes, ...current]))
    }
    if (mimo) nodes = Array.from(new Set(nodes.map(node => node.closest('.relative.mx-auto.flex.w-full') ?? node)))
    return nodes.filter(node => !nodes.some(other => other !== node && other.contains(node)))
      .sort((a, b) => a.compareDocumentPosition(b) & 2 ? 1 : -1)
  })
  const messages: DomMessage[] = []
  const rejected: DomConversation['rejected'] = []
  candidates.forEach((nodes, roleIndex) => {
    const role = roleIndex === 0 ? 'user' : 'assistant'
    nodes.forEach((element, index) => {
      const mimoBubble = mimo ? role === 'user'
        ? element.querySelector(mimoUserSelector)
        : Array.from(document.querySelectorAll(mimoUserSelector))
          .filter(bubble => !bubble.closest(interfaceSelector))
          .filter(bubble => Boolean(bubble.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING))
          .at(-1)
        : undefined
      const mimoIdentity = mimoBubble ? mimoKeys?.get(mimoBubble) : undefined
      const external = element.getAttribute('data-message-id') || element.getAttribute('data-id') || element.id
        || (deepseek ? element.closest('[data-virtual-list-item-key]')?.getAttribute('data-virtual-list-item-key') : undefined)
        || (qianwen ? element.closest('[data-chat]')?.getAttribute('data-chat') : undefined)
        || (kimi ? element.closest('[data-msg-id]')?.getAttribute('data-msg-id') : undefined)
        || (wenxin ? wenxinRoundKey(element) ?? element.getAttribute('rank') : undefined)
        || mimoIdentity?.key
      const key = `${role}:${external || index}`
      const excluded = element.closest(interfaceSelector)
      const loginForm = element.closest('form')?.querySelector('input[type="password"], input[autocomplete="one-time-code"]')
      if (excluded || loginForm) {
        rejected.push({ key, reason: loginForm ? 'login-interface' : 'interface-container', content: nodeText(element) }); return
      }
      if (mimo && !mimoIdentity) {
        rejected.push({ key, reason: 'ambiguous-message-identity', content: nodeText(element) }); return
      }
      const thinking = Array.from(element.querySelectorAll(messageThinkingSelector))
        .filter(node => !node.parentElement?.closest(messageThinkingSelector))
      for (const fragment of Array.from(element.querySelectorAll(interfaceSelector))) {
        if (fragment.parentElement?.closest(interfaceSelector)) continue
        rejected.push({ key: `${key}:interface`, reason: 'interface-container', content: nodeText(fragment) })
      }
      const currentAssistant = deepseek && role === 'assistant' && element.querySelector(deepseekAssistantSelector)
      const contentElement = currentAssistant ? element.querySelector(deepseekAnswerSelector)
        : deepseek && role === 'user' && element.matches(deepseekUserSelector)
          ? element.querySelector(deepseekUserContentSelector) ?? element
          : mimo && role === 'user' ? element.querySelector(mimoUserSelector) ?? element
            : chatglm ? element.querySelector(role === 'user' ? '.question-txt' : '.answer-content') ?? element
              : kimi && role === 'user' ? element.querySelector('.user-content') ?? element : element
      const clone = mimo && role === 'assistant' ? cloneMiMoAnswer(element)
        : (contentElement?.cloneNode(true) as Element | undefined) ?? document.createElement('div')
      if (wenxin && role === 'user') clone.textContent = element.getAttribute('data-query') ?? nodeText(clone)
      if (deepseek && role === 'assistant') stripCodeToolbars(clone)
      clone.querySelectorAll(`${messageThinkingSelector}, ${messageChromeSelector}`).forEach(node => node.remove())
      const content = nodeText(clone).replace(/\n$/, '')
      const noise = classifyCapturedNoise(content)
      if (noise && noise !== 'empty-capture') { rejected.push({ key, reason: noise, content }); return }
      const reasoning = thinking.flatMap(node => {
        if (mimo && node.matches(mimoThinkingSelector)) {
          const bodies = Array.from(node.querySelectorAll('blockquote'))
            .filter(body => !body.parentElement?.closest('blockquote'))
          return bodies.map(body => nodeText(body, true).replace(/\n$/, '')).filter(Boolean)
        }
        if (qianwen && node.matches(qianwenThinkingSelector)) {
          return reasoningFragments(node, '[class*="thinking-content"], [class*="markdown-content"]', messageChromeSelector)
        }
        if (kimi && node.matches(kimiThinkingSelector)) return reasoningFragments(node, '.toolcall-content-text', messageChromeSelector)
        if (wenxin && node.matches(wenxinThinkingSelector)) return reasoningFragments(node, '[class*="_markdown-content_"]', messageChromeSelector)
        if (!deepseek || !node.matches(deepseekThinkingSelector)) {
          const clone = node.cloneNode(true) as Element
          clone.querySelectorAll(messageChromeSelector).forEach(fragment => fragment.remove())
          return [nodeText(clone).replace(/\n$/, '')]
        }
        const fragments = Array.from(node.querySelectorAll('.ds-markdown'))
        return fragments.filter(fragment => !fragments.some(other => other !== fragment && other.contains(fragment)))
          .map(fragment => nodeText(fragment).replace(/\n$/, '')).filter(text => text.trim())
      }).join('\n')
      const explicitStatus = element.getAttribute('data-status')
      const streaming = element.matches('[aria-busy="true"], [data-streaming="true"], [data-is-streaming="true"], [data-is-typing="true"]')
        || !!element.querySelector('[aria-busy="true"], [data-streaming="true"]')
        || (mimo && role === 'assistant' && !!element.querySelector('[class*="DetailRender_shimmer__"], .animate-pulse, [data-is-typing="true"]'))
        || (role === 'assistant' && index === nodes.length - 1 && !!document.querySelector(
          'button[aria-label*="Stop"], button[aria-label*="停止"], button[data-testid="stop-button"]'))
      const status = explicitStatus === 'withdrawn' || explicitStatus === 'stopped' || explicitStatus === 'failed' || explicitStatus === 'streaming'
        ? explicitStatus : streaming ? 'streaming' : 'complete'
      if (!content.trim() && !reasoning.trim() && status === 'complete') return
      messages.push({ element, observed: { key, role, content, markdownContent: markdown(clone).trim(),
        ...(mimoIdentity ? { identityToken: mimoIdentity.token } : {}),
        ...(thinking.length && (!mimo || reasoning.trim()) ? { reasoning } : {}), ...branchIdentity(element), status } })
    })
  })
  messages.sort((a, b) => {
    const position = a.element.compareDocumentPosition(b.element)
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1
    return a.observed.role === 'user' ? -1 : 1
  })
  const first = messages[0]?.element
  const completePath = !document.querySelector('[data-virtualized="true"], [data-messages-partial="true"]')
    && !mimo && !qianwen
    && !(deepseek && document.querySelector('.ds-virtual-list, .ds-virtual-list-items, .ds-virtual-list-visible-items, [data-virtual-list-item-key]'))
    && !(first && Number(first.getAttribute('aria-posinset')) > 1)
  return { messages, rejected, completePath }
}
export function readDomMessages(document: Document, hostname: string): DomMessage[] {
  return readDomConversation(document, hostname).messages
}
