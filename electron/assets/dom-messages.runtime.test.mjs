import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = process.env.SIDEKICK_DOM_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const source = process.env.SIDEKICK_DOM_MESSAGE_SOURCE ?? path.join(root, 'electron/assets/dom-messages.ts')
const user = (id, content = 'Input') => `<div data-virtual-list-item-key="${id}"><div class="d29f3d7d ds-message _63c77b1"><div class="fbb737a4">${content}</div></div></div>`
const thinking = content => `<div class="ds-think-content"><span class="ddd26891">Thinking status</span><div class="_9ecc93a"></div><div class="ds-markdown"><p>${content}</p></div></div>`
const assistant = (id, content = '<p>Answer</p>', reasoning = thinking('Reasoning'), attributes = '') => `<div data-virtual-list-item-key="${id}"><div class="ds-message _63c77b1" ${attributes}><div class="_74c0879">${reasoning}</div>${content ? `<div class="ds-markdown ds-assistant-message-main-content">${content}</div>` : ''}<div class="dbe8cf4a">Toolbar label<button>Copy</button></div></div></div>`
const shell = messages => `<!doctype html><meta charset="utf-8"><title>DOM message contract</title><main>${messages}</main>`
let browser
let parserBundle
let collectorBundle

before(async () => {
  const bytes = await readFile(source)
  console.log(JSON.stringify({ source, sha256: createHash('sha256').update(bytes).digest('hex') }))
  const common = { bundle: true, write: false, platform: 'browser', format: 'iife' }
  const parser = await build({ ...common,
    stdin: { contents: bytes.toString(), loader: 'ts', resolveDir: path.join(root, 'electron/assets') }, globalName: 'DomContract' })
  parserBundle = parser.outputFiles[0].text
  const collector = await build({ ...common, entryPoints: [path.join(root, 'electron/assets/webview-collector.ts')], globalName: 'CollectorContract',
    plugins: [{ name: 'dom-message-contract', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture-ipc' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture-ipc' }, () => ({ loader: 'js', contents:
        'export const ipcRenderer = { invoke: (...args) => window.port.invoke(...args), on: (channel, listener) => { (window.port.listeners[channel] ??= new Set()).add(listener) }, removeListener: (channel, listener) => { window.port.listeners[channel]?.delete(listener) } }' }))
      builder.onResolve({ filter: /^\.\/dom-messages\.js$/ }, () => ({ path: 'parser', namespace: 'fixture-parser' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture-parser' }, () => ({ loader: 'ts', contents: bytes.toString(), resolveDir: path.join(root, 'electron/assets') }))
    } }],
  })
  collectorBundle = collector.outputFiles[0].text
  browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--disable-extensions', '--no-default-browser-check'] })
})

after(async () => { await browser?.close() })

async function fixture(t, messages, hostname = 'chat.deepseek.com', route = '/a/chat/s/structural-fixture') {
  const context = await browser.newContext()
  t.after(() => context.close())
  const target = `https://${hostname}${route}`
  await context.route('**/*', route => route.request().url() === target.split('#')[0]
    ? route.fulfill({ status: 200, contentType: 'text/html', body: shell(messages) }) : route.abort())
  const page = await context.newPage()
  await page.goto(target)
  await page.addScriptTag({ content: parserBundle })
  const parse = () => page.evaluate(() => {
    const result = DomContract.readDomConversation(document, location.hostname)
    return { messages: result.messages.map(item => item.observed), rejected: result.rejected, completePath: result.completePath }
  })
  return { page, parse }
}

const mimoUser = text => `<div class="relative mx-auto flex w-full"><div class="group flex flex-row-reverse"><div class="bg-mimo-bg-message whitespace-pre-wrap">${text}</div><button>Copy</button></div></div>`
const mimoAnswer = (text, reasoning = '', streaming = false) => `<div class="relative mx-auto flex w-full"><div class="group flex flex-row"><div><span>MiMo-V2.6-Pro</span></div><div class="Markdown_markdown__a19823a0">${reasoning ? `<div class="mb-2"><div>Thinking status</div><blockquote><p>${reasoning}</p></blockquote></div>` : ''}<p>${text}</p>${streaming ? '<span class="animate-pulse"></span>' : ''}</div><button>Copy</button></div></div>`

test('captures the public MiMo Studio message component with separate reasoning', async t => {
  const f = await fixture(t, mimoUser('Input') + mimoAnswer('Answer', 'Reasoning'), 'aistudio.xiaomimimo.com', '/#/chat/one')
  const result = await f.parse()
  assert.deepEqual(result.messages.map(({ role, content, reasoning }) => ({ role, content, reasoning })), [
    { role: 'user', content: 'Input', reasoning: undefined },
    { role: 'assistant', content: 'Answer', reasoning: 'Reasoning' },
  ])
  assert.equal(result.completePath, false)
})

test('captures a MiMo prompt after an attachment icon without treating the file bar as a turn', async t => {
  const html = mimoUser('Input').replace('<div class="bg-mimo-bg-message whitespace-pre-wrap">',
    '<div class="file-bar"><span>report.pdf</span><div class="flex h-8 w-8 bg-mimo-bg-message"><svg></svg></div></div><div class="bg-mimo-bg-message whitespace-pre-wrap">')
    + mimoAnswer('Answer')
  const f = await fixture(t, html, 'aistudio.xiaomimimo.com', '/#/chat/one')
  const before = await f.parse()
  assert.deepEqual(before.messages.map(message => message.content), ['Input', 'Answer'])
  await f.page.locator('.file-bar').evaluate(node => node.remove())
  assert.deepEqual((await f.parse()).messages.map(message => message.key), before.messages.map(message => message.key))
})

for (const [hostname, html] of [
  ['wenxin.baidu.com', '<div class="answer-box" data-base-data="{&quot;lid&quot;:&quot;one&quot;}"><div class="_thinking-steps_mo6f1_1"><div class="thinking-steps-title-text">Thinking status</div><div class="_markdown-content_53we2_1"><p>Reasoning</p></div></div><p>Answer</p></div>'],
  ['www.kimi.com', '<div class="segment segment-assistant"><div class="thinking-container"><div class="toolcall-title">Thinking status</div><div class="toolcall-content"><div class="toolcall-content-text"><p>Reasoning</p></div></div></div><p>Answer</p></div>'],
]) test(`separates the confirmed current reasoning body on ${hostname}`, async t => {
  const f = await fixture(t, html, hostname)
  const messages = (await f.parse()).messages
  assert.equal(messages.length, 1)
  assert.equal(messages[0].content, 'Answer')
  assert.equal(messages[0].reasoning, 'Reasoning')
})

test('keeps MiMo turn keys when older distinct prompts are loaded and answers grow', async t => {
  const pair = (input, answer) => `<div>${mimoUser(input)}${mimoAnswer(answer)}</div>`
  const f = await fixture(t, pair('Later input', 'Answer'), 'aistudio.xiaomimimo.com', '/#/chat/one')
  const before = await f.parse()
  await f.page.locator('main').evaluate((node, html) => { node.innerHTML = html }, pair('Earlier input', 'Earlier answer') + pair('Later input', 'Answer continued'))
  const after = await f.parse()
  assert.deepEqual(after.messages.slice(2).map(message => message.key), before.messages.map(message => message.key))
  assert.equal(new Set(after.messages.map(message => message.key)).size, 4)
})

test('retains a known MiMo turn and rejects an ambiguous earlier identical prompt', async t => {
  const pair = (input, answer) => `<div>${mimoUser(input)}${mimoAnswer(answer)}</div>`
  const f = await fixture(t, pair('Same input', 'Latest answer'), 'aistudio.xiaomimimo.com', '/#/chat/one')
  const before = await f.parse()
  await f.page.locator('main').evaluate((node, html) => node.insertAdjacentHTML('afterbegin', html), pair('Same input', 'Earlier answer'))
  const after = await f.parse()
  assert.deepEqual(after.messages, before.messages)
  assert(after.rejected.some(item => item.reason === 'ambiguous-message-identity'))
})

test('retains MiMo message keys when the existing prompt or streaming answer changes', async t => {
  const f = await fixture(t, `<div>${mimoUser('Input')}${mimoAnswer('Answer', '', true)}</div>`, 'aistudio.xiaomimimo.com', '/#/chat/one')
  const before = await f.parse()
  await f.page.locator('.whitespace-pre-wrap').evaluate(node => { node.textContent = 'Edited input' })
  await f.page.locator('[class*="Markdown_markdown__"] p').evaluate(node => { node.textContent = 'Answer continued' })
  const after = await f.parse()
  assert.deepEqual(after.messages.map(message => message.key), before.messages.map(message => message.key))
  assert.deepEqual(after.messages.map(message => message.content), ['Edited input', 'Answer continued'])
})

test('does not reuse an edited MiMo turn identity for a new prompt with the original text', async t => {
  const pair = (input, answer) => `<div>${mimoUser(input)}${mimoAnswer(answer)}</div>`
  const f = await fixture(t, pair('Original', 'Answer'), 'aistudio.xiaomimimo.com', '/#/chat/one')
  const before = await f.parse()
  await f.page.locator('.whitespace-pre-wrap').evaluate(node => { node.textContent = 'Edited' })
  await f.page.locator('main').evaluate((node, html) => node.insertAdjacentHTML('beforeend', html), pair('Original', 'Answer'))
  const after = await f.parse()
  assert.deepEqual(after.messages.map(message => message.key), before.messages.map(message => message.key))
  assert.deepEqual(after.messages.map(message => message.content), ['Edited', 'Answer'])
  assert(after.rejected.some(item => item.reason === 'ambiguous-message-identity'))
})

test('does not collect unrelated MiMo markdown without a prompt anchor', async t => {
  const f = await fixture(t, '<dialog open><div class="Markdown_markdown__sample"><p>Help text</p></div></dialog>', 'aistudio.xiaomimimo.com', '/#/chat/one')
  const result = await f.parse()
  assert.deepEqual(result.messages, [])
  assert(result.rejected.some(item => item.reason === 'ambiguous-message-identity'))
})

test('waits for new MiMo message content after a stable route changes', async t => {
  const f = await fixture(t, `<div>${mimoUser('First')}${mimoAnswer('First answer')}</div>`, 'aistudio.xiaomimimo.com', '/#/chat/one')
  await f.page.evaluate(() => {
    window.port = { calls: [], listeners: {}, invoke(channel, ...args) {
      this.calls.push({ channel, args: structuredClone(args) })
      return Promise.resolve(channel === 'ai-assets:authorize' ? true : { conversationId: 'fixture', messageIds: {} })
    } }
  })
  await f.page.addScriptTag({ content: collectorBundle })
  await f.page.evaluate(() => CollectorContract.startAiAssetCollector())
  await f.page.evaluate(() => { history.pushState(null, '', '#/chat/two'); document.title = 'Other conversation' })
  await f.page.waitForTimeout(800)
  assert.equal(await f.page.evaluate(() => window.port.calls.filter(call => call.channel === 'ai-assets:observe').length), 1)
  await f.page.locator('main').evaluate((node, html) => { node.innerHTML = html }, `<div>${mimoUser('Second')}${mimoAnswer('Second answer')}</div>`)
  await f.page.waitForFunction(() => window.port.calls.filter(call => call.channel === 'ai-assets:observe').length === 2)
  const observations = await f.page.evaluate(() => window.port.calls.filter(call => call.channel === 'ai-assets:observe').map(call => call.args[0]))
  assert.equal(observations[1].conversationKey, 'https://aistudio.xiaomimimo.com/#/chat/two')
  assert.deepEqual(observations[1].messages.map(message => message.content), ['Second', 'Second answer'])
})

test('keeps MiMo hash sessions separate through the collector', async t => {
  const f = await fixture(t, mimoUser('Input') + mimoAnswer('Answer'), 'aistudio.xiaomimimo.com', '/#/c')
  await f.page.evaluate(() => {
    window.port = { calls: [], listeners: {}, invoke(channel, ...args) {
      this.calls.push({ channel, args: structuredClone(args) })
      return Promise.resolve(channel === 'ai-assets:authorize' ? true : { conversationId: 'fixture', messageIds: {} })
    } }
  })
  await f.page.addScriptTag({ content: collectorBundle })
  await f.page.evaluate(() => CollectorContract.startAiAssetCollector())
  const count = () => f.page.evaluate(() => window.port.calls.filter(call => call.channel === 'ai-assets:observe').length)
  assert.equal(await count(), 1)
  await f.page.evaluate(() => { history.pushState(null, '', '#/chat/one') })
  await f.page.waitForFunction(() => window.port.calls.filter(call => call.channel === 'ai-assets:observe').length === 2)
  await f.page.evaluate(html => { history.pushState(null, '', '#/chat/two'); document.querySelector('main').innerHTML = html }, mimoUser('Other input') + mimoAnswer('Other answer'))
  await f.page.waitForFunction(() => window.port.calls.filter(call => call.channel === 'ai-assets:observe').length === 3)
  const observations = await f.page.evaluate(() => window.port.calls.filter(call => call.channel === 'ai-assets:observe').map(call => call.args[0]))
  assert.match(observations[0].conversationKey, /^document:/)
  assert.equal(observations[1].previousConversationKey, observations[0].conversationKey)
  assert.equal(observations[1].conversationKey, 'https://aistudio.xiaomimimo.com/#/chat/one')
  assert.equal(observations[2].conversationKey, 'https://aistudio.xiaomimimo.com/#/chat/two')
  assert.equal(observations[2].previousConversationKey, undefined)
})

for (const [hostname, draft, first, second] of [
  ['aistudio.xiaomimimo.com', '/#/c', '#/chat/one', '#/chat/two'],
  ['chatglm.cn', '/main/alltoolsdetail', '/main/alltoolsdetail?cid=one', '/main/alltoolsdetail?cid=two'],
]) test(`uses a fresh draft identity for another ${hostname} conversation in the same document`, async t => {
  const html = (input, output) => hostname === 'aistudio.xiaomimimo.com' ? `<div>${mimoUser(input)}${mimoAnswer(output)}</div>`
    : '<div data-message-author-role="user" data-message-id="u1">' + input
      + '</div><div data-message-author-role="assistant" data-message-id="a1">' + output + '</div>'
  const f = await fixture(t, html('First', 'First answer'), hostname, draft)
  await f.page.evaluate(() => {
    window.port = { calls: [], listeners: {}, invoke(channel, ...args) {
      this.calls.push({ channel, args: structuredClone(args) })
      return Promise.resolve(channel === 'ai-assets:authorize' ? true : { conversationId: 'fixture', messageIds: {} })
    } }
  })
  await f.page.addScriptTag({ content: collectorBundle })
  await f.page.evaluate(() => CollectorContract.startAiAssetCollector())
  await f.page.evaluate(route => { history.pushState(null, '', route) }, first)
  await f.page.waitForFunction(() => window.port.calls.filter(call => call.channel === 'ai-assets:observe').length === 2)
  await f.page.evaluate(({ route, html }) => { history.pushState(null, '', route); document.querySelector('main').innerHTML = html }, { route: draft, html: html('Second', 'Second answer') })
  await f.page.waitForFunction(() => window.port.calls.filter(call => call.channel === 'ai-assets:observe').length === 3)
  await f.page.evaluate(route => { history.pushState(null, '', route) }, second)
  await f.page.waitForFunction(() => window.port.calls.filter(call => call.channel === 'ai-assets:observe').length === 4)
  const observations = await f.page.evaluate(() => window.port.calls.filter(call => call.channel === 'ai-assets:observe').map(call => call.args[0]))
  assert.notEqual(observations[0].conversationKey, observations[2].conversationKey)
  assert.equal(observations[1].previousConversationKey, observations[0].conversationKey)
  assert.equal(observations[3].previousConversationKey, observations[2].conversationKey)
})

test('captures Qianwen rounds without splitting cards into extra turns', async t => {
  const html = `<div class="chat-round" data-chat="round-1"><div class="chat-question-wrap"><div data-chat-question-wrap="round-1">Input</div><button>Edit</button></div><div data-chat-answers-wrap="round-1"><div data-card_name="deep_think"><div>Thinking status</div><div class="thinking-content-Nzab3u">Reasoning</div></div><div class="answer-common-card"><p>Answer</p></div><button>Copy</button></div></div>`
  const f = await fixture(t, html, 'www.qianwen.com', '/chat/one')
  const result = await f.parse()
  assert.deepEqual(result.messages.map(({ key, role, content, reasoning }) => ({ key, role, content, reasoning })), [
    { key: 'user:round-1', role: 'user', content: 'Input', reasoning: undefined },
    { key: 'assistant:round-1', role: 'assistant', content: 'Answer', reasoning: 'Reasoning' },
  ])
  assert.equal(result.completePath, false)
})

for (const [hostname, userClass, assistantClass, attributes] of [
  ['www.doubao.com', '', '', ['data-testid="user_message"', 'data-testid="assistant_message"']],
  ['www.chatglm.cn', 'chat-item-user', 'chat-item-ai', ['', '']],
  ['www.kimi.com', 'message-block user', 'message-block assistant', ['', '']],
  ['kimi.moonshot.cn', 'message-block user', 'message-block assistant', ['', '']],
  ['yiyan.baidu.com', 'user-question', 'answer-content', ['', '']],
]) test(`captures both roles on ${hostname}`, async t => {
  const f = await fixture(t, `<div class="${userClass}" ${attributes[0]}>Input</div><div class="${assistantClass}" ${attributes[1]}>Answer</div>`, hostname)
  assert.deepEqual((await f.parse()).messages.map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'Input' }, { role: 'assistant', content: 'Answer' },
  ])
})

for (const [hostname, html] of [
  ['www.doubao.com', '<div data-testid="message_content" data-message-id="u1" class="flex-row flex justify-end"><div data-testid="message_text_content">Input</div></div><div data-testid="message_content" data-message-id="a1" class="relative flex-row flex"><div data-testid="preamble-elapsed"><button>Thinking status</button><p>Reasoning</p></div><div data-testid="message_text_content">Answer</div><button data-testid="message_action_copy">Copy</button></div>'],
  ['chatglm.cn', '<div class="conversation question" id="row-question-0"><div class="user-name">Account name</div><div class="question-txt">Input</div><div class="copy-btn">Edit</div></div><div class="answer" id="row-answer-0"><div class="answer-content"><div class="assistant-name">GLM</div><div class="thinking-content"><div class="advance-thinking-status">Thinking status</div><div class="text-thinking-content">Reasoning</div></div><div class="markdown-body">Answer</div></div></div>'],
  ['www.kimi.com', '<div class="segment segment-user"><div class="segment-avatar">Account name</div><div class="user-content">Input</div><div class="segment-user-actions">Edit</div></div><div class="segment segment-assistant"><div class="segment-avatar">Kimi</div><div class="segment-content"><div class="thinking-content">Reasoning</div><p>Answer</p></div><div class="segment-assistant-actions">Copy</div></div>'],
  ['wenxin.baidu.com', '<div class="cs-rank-container"><div class="cs-rank" rank="0" data-query="Input"><div class="cs-question-bubble">Input</div></div><div class="answer-box" data-base-data="{&quot;lid&quot;:&quot;round-1&quot;}"><div class="thinking-content">Reasoning</div><p>Answer</p><button>Copy</button></div></div>'],
]) test(`captures public current message components on ${hostname}`, async t => {
  const f = await fixture(t, html, hostname)
  assert.deepEqual((await f.parse()).messages.map(({ role, content, reasoning }) => ({ role, content, reasoning })), [
    { role: 'user', content: 'Input', reasoning: undefined }, { role: 'assistant', content: 'Answer', reasoning: 'Reasoning' },
  ])
})

test('captures the confirmed current DeepSeek roles and keeps answer and reasoning separate', async t => {
  const f = await fixture(t, user('1') + assistant('2'))
  const result = await f.parse()
  assert.deepEqual(result.messages.map(({ key, role, content, reasoning }) => ({ key, role, content, reasoning })), [
    { key: 'user:1', role: 'user', content: 'Input', reasoning: undefined },
    { key: 'assistant:2', role: 'assistant', content: 'Answer', reasoning: 'Reasoning' },
  ])
  assert.deepEqual(result.messages.map(message => message.markdownContent), ['Input', 'Answer'])
  assert.equal(result.rejected.length, 0)
  assert.equal(result.completePath, false)
})

test('captures only the current user content and assistant answer rather than surrounding controls', async t => {
  const messages = user('1').replace('</div></div></div>', '</div><span>Edit status</span><button>Edit</button></div></div>')
    + assistant('2', '<p><strong>Answer</strong> with <a href="https://example.com/report">reference</a></p>')
  const f = await fixture(t, messages)
  const result = await f.parse()
  assert.equal(result.messages[0].content, 'Input')
  assert.equal(result.messages[1].content, 'Answer with reference')
  assert.equal(result.messages[1].markdownContent, '**Answer** with [reference](https://example.com/report)')
  assert.equal(result.messages[1].reasoning, 'Reasoning')
})

test('keeps the virtual item identity when a reasoning-only assistant gains an answer', async t => {
  const f = await fixture(t, assistant('42', '', thinking('First thought'), 'aria-busy="true"'))
  const initial = (await f.parse()).messages[0]
  assert.equal(initial.key, 'assistant:42')
  assert.equal(initial.content, '')
  assert.equal(initial.reasoning, 'First thought')
  assert.equal(initial.status, 'streaming')
  await f.page.evaluate(content => { document.querySelector('main').innerHTML = content }, assistant('42', '<p>Final answer</p>', thinking('First thought')))
  const final = (await f.parse()).messages[0]
  assert.equal(final.key, initial.key)
  assert.equal(final.content, 'Final answer')
  assert.equal(final.reasoning, initial.reasoning)
  assert.equal(final.status, 'complete')
})

test('collects multiple reasoning fragments without thinking labels or empty decoration', async t => {
  const f = await fixture(t, assistant('2', '<p>Answer</p>', thinking('First') + thinking('Second')
    + '<div class="ds-think-content"><span>Thinking status</span></div>'))
  const result = await f.parse()
  assert.equal(result.messages[0].content, 'Answer')
  assert.equal(result.messages[0].reasoning, 'First\nSecond')
})

test('does not duplicate nested reasoning markdown fragments', async t => {
  const f = await fixture(t, assistant('2', '<p>Answer</p>', '<div class="ds-think-content"><div class="ds-markdown"><p>Outer thought</p><div class="ds-markdown"><p>Inner thought</p></div></div></div>'))
  const result = await f.parse()
  assert.equal(result.messages[0].reasoning, 'Outer thought\nInner thought')
})

test('does not infer user messages from unknown generic DeepSeek containers', async t => {
  const f = await fixture(t, '<div class="ds-message">Unidentified message</div>'
    + '<div class="ds-message d29f3d7d">Missing content marker</div>'
    + '<div class="ds-message"><div class="fbb737a4">Missing user wrapper</div></div>')
  assert.equal((await f.parse()).messages.length, 0)
})

test('keeps interface filtering for current DeepSeek message roots', async t => {
  const f = await fixture(t, '<nav>' + user('menu', 'Account panel') + '</nav>' + user('1') + assistant('2'))
  const result = await f.parse()
  assert.equal(result.messages.length, 2)
  assert.equal(result.rejected.length, 1)
  assert.equal(result.rejected[0].reason, 'interface-container')
})

test('preserves legacy DeepSeek role selectors', async t => {
  const f = await fixture(t, '<div class="ds-message ds-message--user" data-message-id="u">Legacy input</div>'
    + '<div class="ds-message ds-message--assistant" data-message-id="a"><div data-testid="reasoning">Legacy thought</div><p>Legacy answer</p></div>'
    + '<div data-message-author-role="user" data-message-id="u2">Explicit input</div>'
    + '<div data-message-author-role="assistant" data-message-id="a2">Explicit answer</div>')
  const result = await f.parse()
  assert.deepEqual(result.messages.map(message => message.content), ['Legacy input', 'Legacy answer'])
  assert.equal(result.messages[1].reasoning, 'Legacy thought')
})

test('preserves generic explicit role fallback on DeepSeek', async t => {
  const f = await fixture(t, '<div data-message-author-role="user" data-message-id="u">Explicit input</div>'
    + '<div data-message-author-role="assistant" data-message-id="a">Explicit answer</div>')
  const result = await f.parse()
  assert.deepEqual(result.messages.map(message => message.key), ['user:u', 'assistant:a'])
  assert.deepEqual(result.messages.map(message => message.content), ['Explicit input', 'Explicit answer'])
})

test('marks only the final assistant as streaming when current and legacy structures are mixed', async t => {
  const current = assistant('2', '<p>Current answer</p>')
  const legacy = '<div class="ds-message ds-message--assistant" data-message-id="legacy"><p>Legacy answer</p></div>'
  const stop = '<button aria-label="Stop generation">Stop</button>'
  const f = await fixture(t, current + legacy + stop)
  const result = await f.parse()
  assert.deepEqual(result.messages.map(message => [message.key, message.status]), [['assistant:2', 'complete'], ['assistant:legacy', 'streaming']])
  await f.page.evaluate(content => { document.querySelector('main').innerHTML = content }, legacy + current + stop)
  const reversed = await f.parse()
  assert.deepEqual(reversed.messages.map(message => [message.key, message.status]), [['assistant:legacy', 'complete'], ['assistant:2', 'streaming']])
})

test('preserves explicit legacy user content when a current user wrapper lacks its content marker', async t => {
  const f = await fixture(t, '<div class="ds-message ds-message--user d29f3d7d" data-message-id="u">Legacy input</div>')
  const result = await f.parse()
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].content, 'Legacy input')
})

test('preserves fallback behavior and leaves DeepSeek markers scoped to its hostname', async t => {
  const f = await fixture(t, user('1') + assistant('2')
    + '<div data-message-author-role="user" data-message-id="u">Fallback input</div>'
    + '<div data-message-author-role="assistant" data-message-id="a">Fallback answer</div>', 'example.test')
  const result = await f.parse()
  assert.deepEqual(result.messages.map(message => message.key), ['user:u', 'assistant:a'])
  assert.equal(result.completePath, true)
})

test('marks DeepSeek virtual lists as partial and retains keys when earlier items disappear', async t => {
  const f = await fixture(t, '<div class="ds-virtual-list-items"><div class="ds-virtual-list-visible-items">' + user('1') + assistant('2') + user('3', 'Later input') + assistant('4', '<p>Later answer</p>') + '</div></div>')
  const initial = await f.parse()
  assert.equal(initial.completePath, false)
  assert.deepEqual(initial.messages.map(message => message.key), ['user:1', 'assistant:2', 'user:3', 'assistant:4'])
  await f.page.evaluate(content => { document.querySelector('.ds-virtual-list-visible-items').innerHTML = content }, user('3', 'Later input') + assistant('4', '<p>Later answer</p>'))
  const partial = await f.parse()
  assert.equal(partial.completePath, false)
  assert.deepEqual(partial.messages.map(message => message.key), ['user:3', 'assistant:4'])
})

test('the unchanged collector submits a current DeepSeek observation after authorization', async t => {
  const f = await fixture(t, '<div class="ds-virtual-list-items">' + user('1') + assistant('2') + '</div>')
  await f.page.evaluate(() => {
    window.port = { calls: [], listeners: {}, invoke(channel, ...args) {
      this.calls.push({ channel, args: structuredClone(args) })
      if (channel === 'ai-assets:authorize') return Promise.resolve(true)
      if (channel === 'ai-assets:observe') return Promise.resolve({ conversationId: 'fixture', messageIds: {} })
      return Promise.resolve(true)
    } }
  })
  await f.page.addScriptTag({ content: collectorBundle })
  await f.page.evaluate(() => CollectorContract.startAiAssetCollector())
  const observations = await f.page.evaluate(() => {
    const captured = window.port.calls.filter(call => call.channel === 'ai-assets:observe').map(call => call.args[0])
    window.dispatchEvent(new Event('pagehide'))
    return captured
  })
  assert.equal(observations.length, 1)
  assert.deepEqual(observations[0].messages.map(message => message.key), ['user:1', 'assistant:2'])
  assert.equal(observations[0].completePath, false)
})


test('excludes a code toolbar while preserving its language and literal code text', async t => {
  const f = await fixture(t, user('1') + assistant('2', '<div><div><span>html</span><div>复制</div><div>下载</div><div>运行</div></div><pre><code>&lt;p&gt;复制 下载 运行&lt;/p&gt;</code></pre></div>'))
  const message = (await f.parse()).messages[1]
  assert.equal(message.content, '<p>复制 下载 运行</p>')
  assert.equal(message.markdownContent, '```html\n<p>复制 下载 运行</p>\n```')
})

test('preserves toolbar-like user examples and content on other platforms', async t => {
  const markup = '<div><span>html</span><div>复制</div><div>下载</div><div>运行</div></div><pre><code>example</code></pre>'
  const input = await fixture(t, user('1', markup))
  assert((await input.parse()).messages[0].content.includes('复制'))
  const other = await fixture(t, `<div data-message-author-role="assistant">${markup}</div>`, 'example.test')
  assert((await other.parse()).messages[0].content.includes('复制'))
})
