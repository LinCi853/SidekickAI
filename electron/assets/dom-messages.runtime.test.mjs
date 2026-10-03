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

async function fixture(t, messages, hostname = 'chat.deepseek.com') {
  const context = await browser.newContext()
  t.after(() => context.close())
  const target = `https://${hostname}/a/chat/s/structural-fixture`
  await context.route('**/*', route => route.request().url() === target
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
