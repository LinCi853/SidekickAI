import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const source = process.env.SIDEKICK_COLLECTOR_SOURCE ?? path.join(root, 'electron/assets/webview-collector.ts')
const initial = '<div data-message-author-role="user" data-message-id="u1">Input</div><div data-message-author-role="assistant" data-message-id="a1">Answer</div>'
const shell = messages => `<!doctype html><title>Collector contract</title><main id="messages">${messages}</main><input id="upload" type="file">`
let browser
let server
let target
let bundle

before(async () => {
  const bytes = await readFile(source)
  console.log(JSON.stringify({ source, sha256: createHash('sha256').update(bytes).digest('hex') }))
  const compiled = await build({
    stdin: { contents: bytes.toString(), loader: 'ts', resolveDir: path.join(root, 'electron/assets') },
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'CollectorContract',
    plugins: [{ name: 'collector-ipc-port', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `
        export const ipcRenderer = {
          invoke: (...args) => window.port.invoke(...args),
          on: (channel, listener) => { (window.port.listeners[channel] ??= new Set()).add(listener) },
          removeListener: (channel, listener) => { window.port.listeners[channel]?.delete(listener) },
        }
      ` }))
    } }],
  })
  bundle = compiled.outputFiles[0].text
  server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(shell(initial))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  target = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--disable-extensions', '--no-default-browser-check'] })
})

after(async () => {
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
})

async function fixture(t, options = {}) {
  const context = await browser.newContext()
  t.after(() => context.close())
  await context.route('**/*', route => new URL(route.request().url()).origin === target ? route.continue() : route.abort())
  const page = await context.newPage()
  const epoch = new Date('2026-10-03T00:00:00Z')
  if (!options.realClock) {
    await page.clock.install({ time: epoch })
    await page.clock.pauseAt(epoch)
  }
  await page.goto(target + (options.route ?? '/app'))
  if (options.messages !== undefined) await page.setContent(shell(options.messages))
  await page.evaluate(config => {
    window.port = {
      calls: [], accepted: [], listeners: {}, held: {}, nextId: 0, originals: new Map(), saved: new Set(), nodes: new Map(),
      enabled: true, active: 0, maxActive: 0, failures: config.failures ?? 0,
      holds: { 'ai-assets:observe': config.holdObserve ?? 0, 'ai-assets:attachment-begin': config.holdBegin ?? 0,
        'ai-assets:attachment-chunk': config.holdChunk ?? 0, 'ai-assets:authorize': config.holdAuthorize ?? 0 },
      emit(channel, value) { for (const listener of this.listeners[channel] ?? []) listener({}, value) },
      release(channel) { const next = this.held[channel]?.shift(); if (!next) throw new Error('No held IPC'); next() },
      async invoke(channel, ...args) {
        this.calls.push({ channel, args: structuredClone(args), time: Date.now() })
        const observation = channel === 'ai-assets:observe'
        if (observation) { this.active += 1; this.maxActive = Math.max(this.maxActive, this.active) }
        try {
          if (this.holds[channel] > 0) {
            this.holds[channel] -= 1
            await new Promise(resolve => (this.held[channel] ??= []).push(resolve))
          }
          if (channel === 'ai-assets:authorize') return this.enabled
          if (observation) {
            if (this.failures > 0) { this.failures -= 1; throw new Error('Observation write failed') }
            this.accepted.push(structuredClone(args[0]))
            const messageIds = Object.fromEntries(args[0].messages.flatMap(message => {
              if ((config.excludedKeys ?? []).includes(message.key)) return []
              const identity = args[0].conversationKey + '\u0000' + message.key + '\u0000' + (message.versionKey ?? '')
              const id = this.nodes.get(identity) ?? `message-${this.nodes.size + 1}`
              this.nodes.set(identity, id)
              return [[message.key, id]]
            }))
            return { conversationId: 'contract-conversation', ...(config.omitMessageIds ? {} : { messageIds }) }
          }
          if (channel === 'ai-assets:attachment-begin') {
            const key = args[0].conversationKey + '\u0000' + args[0].externalKey
            const id = this.originals.get(key) ?? `original-${++this.nextId}`
            this.originals.set(key, id)
            return { id, saved: this.saved.has(id) }
          }
          if (channel === 'ai-assets:attachment-finish' || channel === 'ai-assets:attachment-fetch') this.saved.add(args[0])
          return true
        } finally { if (observation) this.active -= 1 }
      },
    }
  }, options)
  await page.addScriptTag({ content: bundle })
  await page.evaluate(() => { window.started = CollectorContract.startAiAssetCollector() })
  const settle = async () => { await page.evaluate(async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve() }); await page.waitForTimeout(25) }
  const calls = channel => page.evaluate(value => window.port.calls.filter(call => call.channel === value), channel)
  const advance = async amount => { await page.clock.runFor(amount); await settle() }
  const select = async (name = 'input.txt', size = 12) => {
    await page.evaluate(({ name, size }) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([new Uint8Array(size)], name, { type: 'application/octet-stream' }))
      const input = document.getElementById('upload')
      input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }, { name, size })
    await settle()
  }
  const addUser = async (id, text) => {
    await page.evaluate(({ id, text }) => {
      const message = document.createElement('div')
      message.setAttribute('data-message-author-role', 'user')
      message.setAttribute('data-message-id', id)
      message.textContent = text
      document.getElementById('messages').appendChild(message)
    }, { id, text })
    await settle()
  }
  const navigate = async (route, messages) => {
    await page.evaluate(({ route, messages }) => { history.pushState(null, '', route); document.getElementById('messages').innerHTML = messages }, { route, messages })
    await settle()
  }
  const release = async channel => { await page.evaluate(value => window.port.release(value), channel); await settle() }
  const disable = async () => {
    await page.evaluate(() => { window.port.enabled = false; window.port.emit('ai-assets:collector-state', false) })
    await settle()
  }
  await settle()
  return { page, settle, calls, advance, select, addUser, navigate, release, disable }
}

test('retries an unchanged observation after a rejected write with a natural timer', async t => {
  const f = await fixture(t, { failures: 1, realClock: true })
  assert.equal((await f.calls('ai-assets:observe')).length, 1)
  await f.page.waitForTimeout(1200)
  const observed = await f.calls('ai-assets:observe')
  assert.equal(observed.length, 2)
  assert.deepEqual(observed[1].args, observed[0].args)
  assert.equal(await f.page.evaluate(() => window.port.accepted.length), 1)
})

test('serializes every observed revision and caps retry backoff', async t => {
  const f = await fixture(t, { failures: 6, holdObserve: 1 })
  await f.page.evaluate(() => { document.querySelector('[data-message-id="u1"]').textContent = 'Revised input' })
  await f.settle()
  await f.page.evaluate(() => { document.querySelector('[data-message-id="u1"]').textContent = 'Input' })
  await f.settle()
  assert.equal((await f.calls('ai-assets:observe')).length, 1)
  await f.release('ai-assets:observe')
  for (const duration of [1000, 2000, 4000, 8000, 8000, 8000]) await f.advance(duration)
  const observed = await f.calls('ai-assets:observe')
  assert.equal(observed.length, 9)
  assert.deepEqual(observed.slice(1, 7).map((call, index) => call.time - observed[index].time), [1000, 2000, 4000, 8000, 8000, 8000])
  assert.deepEqual(await f.page.evaluate(() => window.port.accepted.map(item => item.messages[0].content)), ['Input', 'Revised input', 'Input'])
  assert.equal(await f.page.evaluate(() => window.port.maxActive), 1)
  await f.advance(16000)
  assert.equal((await f.calls('ai-assets:observe')).length, 9)
})

test('retries rejected interface evidence without consuming its signature', async t => {
  const f = await fixture(t, { failures: 1, messages: initial + '<nav><div data-message-author-role="user" data-message-id="menu">Sign in</div></nav>' })
  await f.advance(1000)
  const observed = await f.calls('ai-assets:observe')
  assert.equal(observed.length, 2)
  assert.equal(observed[0].args[0].rejected.length, 1)
  assert.deepEqual(observed[1].args[0].rejected, observed[0].args[0].rejected)
})

test('an upload during observation registers independently and belongs to the next input', async t => {
  const f = await fixture(t, { holdObserve: 1 })
  await f.select()
  assert.equal((await f.calls('ai-assets:attachment-begin')).length, 1)
  assert.equal((await f.calls('ai-assets:attachment-finish')).length, 1)
  await f.addUser('u2', 'Following input')
  await f.release('ai-assets:observe')
  assert.equal((await f.calls('ai-assets:observe')).length, 2)
  const associated = await f.calls('ai-assets:attachment-associate')
  assert.equal(associated.length, 1)
  assert.equal(associated[0].args[1], 'user:u2')
})

test('delayed original metadata does not block later text observations', async t => {
  const f = await fixture(t, { holdBegin: 1 })
  await f.select()
  await f.addUser('u2', 'Second input')
  await f.addUser('u3', 'Third input')
  assert.equal(await f.page.evaluate(() => window.port.accepted.length), 3)
  assert.equal((await f.calls('ai-assets:attachment-associate')).length, 0)
  await f.release('ai-assets:attachment-begin')
  const associated = await f.calls('ai-assets:attachment-associate')
  assert.equal(associated.length, 1)
  assert.equal(associated[0].args[1], 'user:u2')
})

test('separately selected identical files retain their own later input', async t => {
  const f = await fixture(t)
  await f.select('same.txt')
  await f.addUser('u2', 'Second input')
  await f.select('same.txt')
  await f.addUser('u3', 'Third input')
  const associated = await f.calls('ai-assets:attachment-associate')
  assert.deepEqual(associated.map(call => call.args[1]), ['user:u2', 'user:u3'])
  assert.notDeepEqual(associated[0].args[2], associated[1].args[2])
})

test('an upload from conversation A cannot attach to conversation B', async t => {
  const f = await fixture(t, { route: '/conversation/A' })
  await f.select()
  await f.navigate('/conversation/B', '<div data-message-author-role="user" data-message-id="b1">Other conversation</div>')
  assert.equal((await f.calls('ai-assets:attachment-associate')).length, 0)
  await f.navigate('/conversation/A', initial)
  await f.addUser('u2', 'Following A input')
  const associated = await f.calls('ai-assets:attachment-associate')
  assert.equal(associated.length, 1)
  assert.equal(associated[0].args[0].conversationKey, target + '/conversation/A')
  assert.equal(associated[0].args[1], 'user:u2')
})

test('an empty stable route and a failed write retain the draft alias and upload', async t => {
  const f = await fixture(t)
  const draft = (await f.calls('ai-assets:observe'))[0].args[0].conversationKey
  await f.select()
  await f.navigate('/conversation/stable', '')
  await f.advance(1000)
  assert.equal((await f.calls('ai-assets:observe')).length, 1)
  await f.page.evaluate(() => { window.port.failures = 1 })
  await f.navigate('/conversation/stable', initial + '<div data-message-author-role="user" data-message-id="u2">Following input</div>')
  await f.advance(1000)
  const observed = await f.calls('ai-assets:observe')
  assert.equal(observed.length, 3)
  assert.equal(observed[1].args[0].previousConversationKey, draft)
  assert.deepEqual(observed[2].args, observed[1].args)
  const associated = await f.calls('ai-assets:attachment-associate')
  assert.equal(associated.length, 1)
  assert.equal(associated[0].args[0].conversationKey, target + '/conversation/stable')
  assert.equal(associated[0].args[1], 'user:u2')
})

test('an unrelated stable conversation cannot inherit a nonempty draft upload', async t => {
  const f = await fixture(t)
  await f.select()
  await f.navigate('/conversation/unrelated', '<div data-message-author-role="user" data-message-id="b1">Unrelated input</div>')
  const observed = await f.calls('ai-assets:observe')
  assert.equal(observed[1].args[0].previousConversationKey, undefined)
  assert.equal((await f.calls('ai-assets:attachment-associate')).length, 0)
})

test('an empty draft upload belongs to its first stable submission', async t => {
  const f = await fixture(t, { messages: '' })
  await f.select()
  await f.navigate('/conversation/new', initial)
  const associated = await f.calls('ai-assets:attachment-associate')
  assert.equal(associated.length, 1)
  assert.equal(associated[0].args[0].conversationKey, target + '/conversation/new')
  assert.equal(associated[0].args[1], 'user:u1')
})

test('a disabled notification retires queued work before authorization can return', async t => {
  const f = await fixture(t, { holdObserve: 1 })
  await f.page.evaluate(() => { window.port.holds['ai-assets:authorize'] = 1 })
  await f.addUser('u2', 'Queued input')
  await f.disable()
  await f.release('ai-assets:observe')
  await f.select()
  await f.advance(16000)
  assert.equal((await f.calls('ai-assets:observe')).length, 1)
  assert.equal((await f.calls('ai-assets:attachment-begin')).length, 0)
  assert.equal((await f.calls('ai-assets:attachment-associate')).length, 0)
})

test('disable cancels retry waits and re-enable creates a separate lifetime', async t => {
  const f = await fixture(t, { failures: 1 })
  const original = (await f.calls('ai-assets:observe'))[0].args[0]
  await f.disable()
  await f.advance(16000)
  assert.equal((await f.calls('ai-assets:observe')).length, 1)
  await f.page.evaluate(() => { window.port.enabled = true; window.port.emit('ai-assets:collector-state', true) })
  await f.settle()
  const observed = await f.calls('ai-assets:observe')
  assert.equal(observed.length, 2)
  assert.notEqual(observed[1].args[0].conversationKey, original.conversationKey)
  assert.notEqual(observed[1].args[0].visitId, original.visitId)
  await f.advance(16000)
  assert.equal((await f.calls('ai-assets:observe')).length, 2)
})

test('page exit invalidates a pending authorization response', async t => {
  const f = await fixture(t, { holdAuthorize: 1 })
  await f.page.evaluate(() => { window.dispatchEvent(new Event('pagehide')) })
  await f.release('ai-assets:authorize')
  await f.page.evaluate(() => { window.port.emit('ai-assets:collector-state', true) })
  await f.advance(16000)
  assert.equal((await f.calls('ai-assets:observe')).length, 0)
})

test('a late metadata response cannot start retired byte transport', async t => {
  const f = await fixture(t, { holdBegin: 1 })
  await f.select()
  await f.disable()
  await f.release('ai-assets:attachment-begin')
  assert.equal((await f.calls('ai-assets:attachment-chunk')).length, 0)
  assert.equal((await f.calls('ai-assets:attachment-finish')).length, 0)
  assert.equal((await f.calls('ai-assets:attachment-fail')).length, 0)
})

test('a late fragment response cannot submit more fragments or finalize after retirement', async t => {
  const f = await fixture(t, { holdChunk: 1 })
  await f.select('large.bin', 3 * 1024 * 1024)
  await f.disable()
  await f.release('ai-assets:attachment-chunk')
  assert.equal((await f.calls('ai-assets:attachment-chunk')).length, 1)
  assert.equal((await f.calls('ai-assets:attachment-finish')).length, 0)
  assert.equal((await f.calls('ai-assets:attachment-fail')).length, 0)
})

test('completed input originals retain explicit saved-original retry behavior', async t => {
  const f = await fixture(t)
  await f.select()
  await f.addUser('u2', 'Following input')
  await f.page.evaluate(() => { window.port.emit('ai-assets:retry-request', { id: 'original-1' }) })
  await f.settle()
  assert.equal((await f.calls('ai-assets:attachment-begin')).length, 2)
  assert.equal((await f.calls('ai-assets:attachment-chunk')).length, 1)
  assert.equal((await f.calls('ai-assets:attachment-finish')).length, 1)
  assert.equal((await f.calls('ai-assets:attachment-fail')).length, 0)
})

test('output originals wait for their parent observation acknowledgement', async t => {
  const f = await fixture(t, { holdObserve: 1, messages: initial.replace('Answer</div>', 'Answer<a data-attachment href="data:text/plain,original">file</a></div>') })
  assert.equal((await f.calls('ai-assets:attachment-begin')).length, 0)
  await f.release('ai-assets:observe')
  const begun = await f.calls('ai-assets:attachment-begin')
  assert.equal(begun.length, 1)
  assert.equal(begun[0].args[0].messageKey, 'assistant:a1')
  assert.equal(begun[0].args[0].messageId, 'message-2')
  assert.equal(begun[0].args[0].direction, 'output')
  assert.equal((await f.calls('ai-assets:attachment-finish')).length, 1)
})

test('late upload metadata keeps the exact observed branch node', async t => {
  const f = await fixture(t, { messages: '', holdBegin: 1 })
  await f.select()
  await f.navigate('/conversation/branch', '<div data-message-author-role="user" data-message-id="u1" data-version-id="v1">First version</div>')
  await f.navigate('/conversation/branch', '<div data-message-author-role="user" data-message-id="u1" data-version-id="v2">Second version</div>')
  await f.release('ai-assets:attachment-begin')
  const associated = await f.calls('ai-assets:attachment-associate')
  assert.equal(associated.length, 1)
  assert.equal(associated[0].args[1], 'user:u1')
  assert.equal(associated[0].args[3], 'message-1')
  assert.equal(await f.page.evaluate(() => [...window.port.nodes.values()].at(-1)), 'message-2')
})

test('an uncaptured node cannot receive input or output original references', async t => {
  const f = await fixture(t, { messages: '', excludedKeys: ['user:u1', 'assistant:a1'] })
  await f.select()
  await f.navigate('/conversation/excluded', initial.replace('Answer</div>', 'Answer<a data-attachment href="data:text/plain,original">file</a></div>'))
  assert.equal((await f.calls('ai-assets:attachment-begin')).length, 1)
  assert.equal((await f.calls('ai-assets:attachment-associate')).length, 0)
})

test('legacy observation results without node mappings retain input association', async t => {
  const f = await fixture(t, { omitMessageIds: true })
  await f.select()
  await f.addUser('u2', 'Following input')
  const associated = await f.calls('ai-assets:attachment-associate')
  assert.equal(associated.length, 1)
  assert.equal(associated[0].args[1], 'user:u2')
  assert.equal(associated[0].args[3], undefined)
})
