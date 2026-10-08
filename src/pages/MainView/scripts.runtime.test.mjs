import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { editFixtures, editComposer, platformComposers } from './edit-shortcuts.fixtures.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const source = process.env.SIDEKICK_ENTER_SCRIPT_SOURCE ?? path.join(root, 'src/pages/MainView/scripts.ts')
const sendSelector = 'div[role="button"].ds-button.ds-button--primary.ds-button--filled.ds-button--circle'
const sendLabel = '\u53d1\u9001'
const cancelLabel = '\u53d6\u6d88'
const capsule = (action, extra = '') => `<div role="button" class="ds-button ds-button--${action === 'send' ? 'primary ds-button--filled' : 'outlinedNeutral ds-button--outlined'} ds-button--capsule ds-button--s ds-button--icon-relative-m ds-button--min-width" tabindex="0" data-action="${action}" ${extra}><div class="ds-button__background"></div>${action === 'cancel' ? '<div class="ds-button__border"></div>' : ''}<span class="ds-button__content">${action === 'send' ? sendLabel : cancelLabel}</span></div>`
const editor = (id = 'edit', attributes = '') => `<article id="${id}"><div class="input-wrap"><textarea ${attributes}>Historical prompt</textarea></div><div class="actions">${capsule('send')}${capsule('cancel')}</div></article>`
const composer = '<footer><textarea id="chat-input">New prompt</textarea><div role="button" class="ds-button ds-button--primary ds-button--filled ds-button--circle" data-action="compose">Arrow</div></footer>'
let browser
let bundle
let blockerBundle

before(async () => {
  const bytes = await readFile(source)
  console.log(JSON.stringify({ source, sha256: createHash('sha256').update(bytes).digest('hex') }))
  const output = await build({ stdin: { contents: bytes.toString() + '\nexport { AI_PLATFORMS } from "../../../electron/presets/ai-platforms.ts"; export { triggerSendInWebview } from "../../hooks/useWebViewControl.ts"', loader: 'ts', resolveDir: path.dirname(source) },
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'EnterContract' })
  bundle = output.outputFiles[0].text
  const blocker = await build({ stdin: { contents: "export { BLOCK_RULES } from './electron/store/block-rules-preset.ts'; export { buildBlockerScript } from './src/lib/webview-blocker.ts'", resolveDir: root },
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'BlockContract' })
  blockerBundle = blocker.outputFiles[0].text
  browser = await chromium.launch({ channel: 'chrome', headless: false })
})
after(async () => { await browser?.close() })

async function fixture(t, html = editor() + composer, hostname = 'chat.deepseek.com') {
  const context = await browser.newContext()
  t.after(() => context.close())
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body:
    `<!doctype html><meta charset="utf-8"><style>[role=button]{display:inline-block;padding:8px}textarea{display:block}</style><main>${html}</main>` }))
  const page = await context.newPage()
  await page.goto(`https://${hostname}/a/chat/s/shortcut-fixture`)
  await page.addScriptTag({ content: bundle })
  await page.evaluate(() => {
    window.clicks = []
    document.addEventListener('click', event => {
      const button = event.target.closest('[data-action]')
      if (button) window.clicks.push(`${button.closest('article')?.id ?? 'normal'}:${button.dataset.action}`)
    })
    const platform = EnterContract.AI_PLATFORMS.find(platform => platform.pageAdapter?.hosts.includes(location.hostname))
    if (platform?.pageAdapter.sendEvent === 'mousedown') {
      document.addEventListener('mousedown', event => {
        const button = event.target.closest('[data-action=compose]')
        if (button) window.clicks.push('normal:compose')
      })
    }
  })
  const inject = options => page.evaluate(options => (0, eval)(EnterContract.buildEnterToSendScript({
    enabled: true, inputSelector: '#chat-input', sendSelector: options.sendSelector,
    pageAdapter: EnterContract.AI_PLATFORMS.find(platform => platform.pageAdapter?.hosts.includes(location.hostname))?.pageAdapter, ...options,
  })), { sendSelector, ...options })
  const key = (key = 'Enter', selector = '#edit textarea', options = {}) => page.evaluate(({ key, selector, options }) => {
    const target = document.querySelector(selector)
    target.focus()
    const event = new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true, ...options })
    target.dispatchEvent(event)
    return { clicks: window.clicks.slice(), prevented: event.defaultPrevented }
  }, { key, selector, options })
  await inject()
  return { page, key, inject }
}

test('Enter sends the historical editor instead of the normal composer', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.key(), { clicks: ['edit:send'], prevented: true })
})

test('Escape cancels the historical editor', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.key('Escape'), { clicks: ['edit:cancel'], prevented: true })
})

test('two editors stay associated with their own actions', async t => {
  const f = await fixture(t, editor('first') + editor('second') + composer)
  await f.key('Enter', '#second textarea')
  assert.deepEqual(await f.key('Escape', '#first textarea'), { clicks: ['second:send', 'first:cancel'], prevented: true })
})

test('normal composer Enter and Escape retain their behavior', async t => {
  const f = await fixture(t)
  await f.key('Enter', '#chat-input')
  assert.deepEqual(await f.key('Escape', '#chat-input'), { clicks: ['normal:compose'], prevented: false })
})

test('default download blocking retains the editing cancel button', async t => {
  const f = await fixture(t, editor() + composer + '<aside class="app-download">Download app</aside>')
  await f.page.addScriptTag({ content: blockerBundle })
  await f.page.evaluate(() => (0, eval)(BlockContract.buildBlockerScript(BlockContract.BLOCK_RULES
    .filter(rule => rule.enabled && rule.type === 'css' && rule.domainPattern === '*.deepseek.com'))))
  assert.equal(await f.page.locator('#edit [data-action=cancel]').isVisible(), true)
  assert.equal(await f.page.locator('.app-download').isVisible(), false)
  await f.key()
  assert.deepEqual(await f.key('Escape'), { clicks: ['edit:send', 'edit:cancel'], prevented: true })
})

test('contenteditable descendants use the editor actions', async t => {
  const f = await fixture(t, editor().replace('<textarea >Historical prompt</textarea>', '<div contenteditable="true"><span id="nested">Historical prompt</span></div>') + composer)
  assert.deepEqual(await f.key('Enter', '#nested'), { clicks: ['edit:send'], prevented: true })
})

test('hidden editors and unrelated capsule labels are ignored', async t => {
  const f = await fixture(t, editor('hidden').replace('<article', '<article style="display:none"') + editor().replace('<div class="actions">', `<div class="actions">${capsule('send').replace(sendLabel, 'Search')}`) + composer)
  assert.deepEqual(await f.key(), { clicks: ['edit:send'], prevented: true })
})

for (const attributes of ['aria-disabled="true"', 'disabled', 'style="display:none"', 'style="pointer-events:none"']) {
  test(`unavailable editing send does not fall back to compose: ${attributes}`, async t => {
    const f = await fixture(t, editor().replace('data-action="send"', `data-action="send" ${attributes}`) + composer)
    assert.deepEqual(await f.key(), { clicks: [], prevented: false })
  })
}

test('ambiguous editing sends do not fall back to compose', async t => {
  const f = await fixture(t, editor().replace('<div class="actions">', `<div class="actions">${capsule('send')}`) + composer)
  assert.deepEqual(await f.key(), { clicks: [], prevented: false })
})

test('hidden editing actions do not fall back to compose', async t => {
  const f = await fixture(t, editor().replace('<div class="actions">', '<div class="actions" style="display:none">') + composer)
  assert.deepEqual(await f.key(), { clicks: [], prevented: false })
  assert.deepEqual(await f.key('Escape'), { clicks: [], prevented: false })
})

test('incomplete editing controls do not select a different composer', async t => {
  const f = await fixture(t, editor().replace(capsule('cancel'), '') + composer)
  assert.deepEqual(await f.key(), { clicks: [], prevented: false })
})

test('hidden incomplete editing controls do not select a different composer', async t => {
  const f = await fixture(t, editor().replace(capsule('cancel'), '').replace('<div class="actions">', '<div class="actions" style="display:none">') + composer)
  assert.deepEqual(await f.key(), { clicks: [], prevented: false })
})

test('a hidden historical editor never owns the normal composer', async t => {
  const f = await fixture(t, editor().replace('<article', '<article style="display:none"') + composer)
  assert.deepEqual(await f.key('Enter', '#chat-input'), { clicks: ['normal:compose'], prevented: true })
})

test('one editing key does not also reach the page shortcut listener', async t => {
  const f = await fixture(t)
  await f.page.evaluate(() => {
    document.addEventListener('keydown', () => document.querySelector('#edit [data-action=send]').click(), true)
  })
  assert.deepEqual(await f.key(), { clicks: ['edit:send'], prevented: true })
})

test('editing controls are restricted to the verified DeepSeek host', async t => {
  const f = await fixture(t, editor() + composer, 'example.com')
  assert.deepEqual(await f.key('Escape'), { clicks: [], prevented: false })
})

for (const options of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
  test(`editing shortcuts preserve keyboard bypass: ${JSON.stringify(options)}`, async t => {
    const f = await fixture(t)
    assert.deepEqual(await f.key('Enter', '#edit textarea', options), { clicks: [], prevented: false })
    assert.deepEqual(await f.key('Escape', '#edit textarea', options), { clicks: [], prevented: false })
  })
}

test('settings, cleanup and reinjection preserve listener ownership', async t => {
  const f = await fixture(t)
  await f.inject()
  assert.deepEqual(await f.key(), { clicks: ['edit:send'], prevented: true })
  await f.page.evaluate(() => { window.clicks = []; window.__ai_enter_send_enabled__ = false })
  assert.deepEqual(await f.key('Escape'), { clicks: [], prevented: false })
  await f.page.evaluate(() => (0, eval)(EnterContract.buildEnterToSendCleanupScript()))
  assert.deepEqual(await f.key(), { clicks: [], prevented: false })
  await f.inject({ enabled: false })
  assert.deepEqual(await f.key('Escape'), { clicks: [], prevented: false })
})

test('editable validation and other focused inputs preserve page behavior', async t => {
  const f = await fixture(t, editor('edit', 'readonly') + '<input id="search" value="Search">' + composer)
  assert.deepEqual(await f.key(), { clicks: [], prevented: false })
  assert.deepEqual(await f.key('Escape', '#search'), { clicks: [], prevented: false })
})

for (const sample of editFixtures.filter(sample => !sample.native)) {
  test(`${sample.id} historical editing stays local for Enter and Escape`, async t => {
    const f = await fixture(t, sample.html + editComposer, sample.host)
    await f.inject({ sendSelector: '.compose' })
    const selector = '#edit textarea, #edit [contenteditable=true] span'
    assert.deepEqual(await f.key('Enter', selector), { clicks: ['edit:send'], prevented: true })
    assert.deepEqual(await f.key('Escape', selector), { clicks: ['edit:send', 'edit:cancel'], prevented: true })
    await f.page.evaluate(() => { window.clicks = [] })
    assert.deepEqual(await f.key('Enter', '#chat-input'), { clicks: ['normal:compose'], prevented: true })
    assert.deepEqual(await f.key('Escape', '#chat-input'), { clicks: ['normal:compose'], prevented: false })
  })
}

test('MiMo native bottom editing retains Enter and Escape ownership', async t => {
  const sample = editFixtures.find(sample => sample.native)
  const f = await fixture(t, sample.html + editComposer, sample.host)
  await f.inject({ sendSelector: '.compose' })
  await f.page.evaluate(() => {
    document.addEventListener('keydown', event => {
      if (!event.target.closest('.dialogue-container')) return
      if (event.key === 'Enter') document.querySelector('[data-track-id=home_send_btn]').click()
      if (event.key === 'Escape') window.clicks.push('edit:cancel')
    })
  })
  assert.deepEqual(await f.key(), { clicks: ['edit:send'], prevented: false })
  assert.deepEqual(await f.key('Escape'), { clicks: ['edit:send', 'edit:cancel'], prevented: false })
})

test('unrelated forms and settings retain native ownership on AI hosts', async t => {
  const f = await fixture(t, '<article id="edit"><textarea>Settings</textarea><button data-action="send">Save</button><button data-action="cancel">Cancel</button></article>' + editComposer, 'chatgpt.com')
  await f.inject({ sendSelector: '.compose' })
  assert.deepEqual(await f.key(), { clicks: [], prevented: false })
  assert.deepEqual(await f.key('Escape'), { clicks: [], prevented: false })
})

test('Qianwen disabled class retains the original event without composing', async t => {
  const sample = editFixtures.find(sample => sample.id === 'qianwen')
  const f = await fixture(t, sample.html.replace('secondary-ADUwM0', 'secondary-ADUwM0 disable-ap2XjU') + editComposer, sample.host)
  await f.inject({ sendSelector: '.compose' })
  assert.deepEqual(await f.key(), { clicks: [], prevented: false })
})

test('Kimi suggestions and previously handled events retain native ownership', async t => {
  const sample = editFixtures.find(sample => sample.id === 'kimi')
  const f = await fixture(t, sample.html + '<div role="listbox">Suggestion</div>' + editComposer, sample.host)
  await f.inject({ sendSelector: '.compose' })
  assert.deepEqual(await f.key('Escape', '#nested'), { clicks: [], prevented: false })
  assert.deepEqual(await f.key('Enter', '#nested'), { clicks: [], prevented: false })
  await f.page.locator('[role=listbox]').evaluate(element => element.remove())
  await f.page.evaluate(() => {
    window.__ai_enter_send__.dispose()
    document.addEventListener('keydown', event => event.preventDefault(), true)
  })
  await f.inject({ sendSelector: '.compose' })
  assert.deepEqual(await f.key('Enter', '#nested'), { clicks: [], prevented: true })
})

for (const sample of editFixtures.filter(sample => !sample.native)) {
  test(`${sample.id} unavailable or incomplete editing cannot select another composer`, async t => {
    const f = await fixture(t, sample.html + editComposer, sample.host)
    await f.inject({ sendSelector: '.compose' })
    const selector = '#edit textarea, #edit [contenteditable=true] span'
    const original = await f.page.locator('#edit').innerHTML()
    for (const attribute of ['hidden', 'disabled', 'aria-disabled', 'pointer']) {
      await f.page.locator('#edit').evaluate((element, { original, attribute }) => {
        element.innerHTML = original
        const send = element.querySelector('[data-action=send]')
        if (attribute === 'pointer') send.style.pointerEvents = 'none'
        else send.setAttribute(attribute, attribute === 'aria-disabled' ? 'true' : '')
        window.clicks = []
      }, { original, attribute })
      assert.deepEqual(await f.key('Enter', selector), { clicks: [], prevented: false })
    }
    await f.page.locator('#edit').evaluate((element, original) => {
      element.innerHTML = original
      element.querySelector('[data-action=cancel]').remove()
      window.clicks = []
    }, original)
    assert.deepEqual(await f.key('Enter', selector), { clicks: [], prevented: false })
    assert.deepEqual(await f.key('Escape', selector), { clicks: [], prevented: false })
  })
}

test('normal sending never uses a global button across another editable root', async t => {
  const f = await fixture(t, '<article id="edit"><textarea>Unrelated text</textarea><button>Upload</button></article>' + editComposer, 'chatglm.cn')
  await f.inject({ inputSelector: 'textarea', sendSelector: '.compose' })
  assert.deepEqual(await f.key(), { clicks: [], prevented: false })
})

test('normal sending accepts changed contenteditable inputs through a local configured button', async t => {
  const f = await fixture(t, '<footer><div id="chat-input" contenteditable="true"><span id="nested">New input</span></div><button class="compose" data-action="compose">Send</button></footer>', 'chatgpt.com')
  await f.inject({ inputSelector: 'textarea#old-input', sendSelector: '.compose' })
  assert.deepEqual(await f.key('Enter', '#nested'), { clicks: ['normal:compose'], prevented: true })
})

test('declarative adapter data survives JSON round trips and supports new applications', async t => {
  const f = await fixture(t, '<article id="edit" class="history-edit"><textarea>Custom input</textarea><button class="confirm" data-action="send">Submit changes</button><button class="cancel" data-action="cancel">Discard changes</button></article>' + editComposer, 'custom.example')
  await f.inject({ sendSelector: '.compose', pageAdapter: JSON.parse(JSON.stringify({ version: 1, hosts: ['custom.example'], messageEdit: {
    rootSelector: '.history-edit', sendSelector: '.confirm', cancelSelector: '.cancel',
  } })) })
  assert.deepEqual(await f.key(), { clicks: ['edit:send'], prevented: true })
  assert.deepEqual(await f.key('Escape'), { clicks: ['edit:send', 'edit:cancel'], prevented: true })
})

test('application adapters cannot run on login domains or arbitrary subdomains', async t => {
  const sample = editFixtures.find(sample => sample.id === 'chatgpt')
  const f = await fixture(t, sample.html + editComposer, 'auth.openai.com')
  const pageAdapter = await f.page.evaluate(() => EnterContract.AI_PLATFORMS.find(platform => platform.id === 'chatgpt').pageAdapter)
  await f.inject({ pageAdapter, sendSelector: '.compose' })
  assert.deepEqual(await f.key(), { clicks: [], prevented: false })
  assert.deepEqual(await f.key('Escape'), { clicks: [], prevented: false })
})

for (const sample of editFixtures) {
  test(`${sample.id} normal sending executes its application data`, async t => {
    const f = await fixture(t, sample.html + platformComposers[sample.id], sample.host)
    const platform = await f.page.evaluate(() => EnterContract.AI_PLATFORMS.find(platform => platform.pageAdapter?.hosts.includes(location.hostname)))
    await f.inject({ inputSelector: platform.inputSelector, sendSelector: platform.sendSelector })
    assert.deepEqual(await f.key('Enter', '[data-composer]'), { clicks: ['normal:compose'], prevented: true })
  })
}

test('voice sending uses the declarative mouse event', async t => {
  const f = await fixture(t, platformComposers.chatglm, 'chatglm.cn')
  const result = await f.page.evaluate(async () => {
    const platform = EnterContract.AI_PLATFORMS.find(platform => platform.id === 'chatglm')
    const sent = await EnterContract.triggerSendInWebview({ executeJavaScript: async script => (0, eval)(script) },
      platform.sendSelector, platform.inputSelector, platform.pageAdapter.sendEvent)
    return { sent, clicks: window.clicks }
  })
  assert.deepEqual(result, { sent: true, clicks: ['normal:compose'] })
})

test('an editable message boundary cannot claim actions outside itself', async t => {
  const f = await fixture(t, '<article id="edit"><div contenteditable="true" data-testid="user-message"><span id="nested">History</span></div><button data-action="send">Save</button><button data-action="cancel">Cancel</button></article>' + editComposer, 'claude.ai')
  await f.inject({ sendSelector: '.compose' })
  assert.deepEqual(await f.key('Escape', '#nested'), { clicks: [], prevented: false })
})

test('an empty active-descendant attribute does not disable editing', async t => {
  const sample = editFixtures.find(sample => sample.id === 'kimi')
  const f = await fixture(t, sample.html.replace('contenteditable="true"', 'contenteditable="true" aria-activedescendant=""') + editComposer, sample.host)
  await f.inject({ sendSelector: '.compose' })
  assert.deepEqual(await f.key('Enter', '#nested'), { clicks: ['edit:send'], prevented: true })
})

test('normal sending does not also invoke a native document shortcut', async t => {
  const f = await fixture(t, platformComposers.chatgpt, 'chatgpt.com')
  await f.inject({ sendSelector: '[data-testid=send-button]' })
  await f.page.evaluate(() => document.addEventListener('keydown', () => document.querySelector('[data-action=compose]').click(), true))
  assert.deepEqual(await f.key('Enter', '[data-composer]'), { clicks: ['normal:compose'], prevented: true })
})
