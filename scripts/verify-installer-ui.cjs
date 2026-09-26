const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const root = path.resolve(__dirname, '..')
const dist = path.join(root, 'installer-tauri/dist')
const evidence = fs.mkdtempSync(path.join(root, 'local/installer-ui-'))
const report = { evidence, boundary: 'Real compiled renderer with a simulated native bridge', checks: [], failures: [] }

async function run() {
  const server = http.createServer((request, response) => {
    const relative = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
    const file = path.resolve(dist, '.' + (relative === '/' ? '/index.html' : relative))
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file)) { response.writeHead(404).end(); return }
    response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html')
    response.end(fs.readFileSync(file))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const browser = await chromium.launch({ headless: false })
  try {
    async function fixture(maintenance = false) {
      const page = await browser.newPage({ viewport: { width: 960, height: 620 } })
      await page.addInitScript(({ maintenance }) => {
        const state = { callbacks: {}, calls: [], closed: false, flushError: false, startError: false, held: false }
        const perUser = 'E:/fixture/user/SidekickAI-OpenSource'
        const selected = 'E:/fixture/custom/SidekickAI-OpenSource'
        const info = {
          initialMode: maintenance ? 'uninstall' : 'install', initialTarget: maintenance ? selected : '',
          version: '0.1.0-alpha.3', defaultDir: 'E:/fixture/system/SidekickAI-OpenSource', perUserDefaultDir: perUser,
          appName: 'SidekickAI-OpenSource', arch: 'x64', requiredSpace: '500 MB', licenses: [],
          features: [{ id: 'notes', label: '笔记', description: '本地笔记', defaultEnabled: true }],
          options: [{ id: 'autoStart', label: '开机启动', description: '随系统启动', type: 'boolean', defaultValue: false }]
        }
        const location = (directory, all) => ({ path: directory, forAllUsers: all, version: info.version, arch: 'x64', registered: true, runningPid: 0 })
        const api = {
          getInfo: async () => info,
          scanInstallations: async () => ({ locations: maintenance ? [location(perUser, false), location(selected, true)] : [], recommendedDir: perUser, fixedDrives: [], residualHint: '' }),
          readInstallConfig: async directory => { state.calls.push(['read', directory]); return { modules: {}, options: { autoStart: directory === selected } } },
          needsAdmin: async () => false,
          browseDir: async current => current,
          saveBackupDialog: async () => '',
          start: async options => { state.calls.push(['start', options]); if (state.startError) throw new Error('start refused'); if (!state.held) setTimeout(() => state.callbacks.done({ installDir: options.installDir, residualNote: '' }), 50); return true },
          flushConfig: async options => { state.calls.push(['flush', options]); await new Promise(resolve => setTimeout(resolve, 120)); if (state.flushError) throw new Error('write refused'); return true },
          setPendingLaunch: async (...args) => { state.calls.push(['launch', ...args]); return true },
          cancel: async () => { state.calls.push(['cancel']); return true },
          closeWindow: async () => { state.closed = true; state.calls.push(['close']) },
          openDir: async () => {},
          onStatus: callback => { state.callbacks.status = callback; return () => {} },
          onProgress: callback => { state.callbacks.progress = callback; return () => {} },
          onDone: callback => { state.callbacks.done = callback; return () => {} },
          onError: callback => { state.callbacks.error = callback; return () => {} },
          onCloseRequested: callback => { state.callbacks.close = callback; return () => { if (state.callbacks.close === callback) delete state.callbacks.close } }
        }
        Object.defineProperty(window, 'installer', { get: () => api, set: () => {}, configurable: true })
        window.fixture = { state, info, selected }
      }, { maintenance })
      await page.goto('http://127.0.0.1:' + server.address().port)
      await page.waitForFunction(() => document.querySelector('.sk-wizard__version')?.textContent?.startsWith('v'))
      return page
    }
    async function check(name, action) {
      try { await action(); report.checks.push(name) } catch (error) { report.failures.push({ name, error: error.stack }) }
    }
    async function finishInstall(page) {
      await page.getByRole('button', { name: '下一步', exact: true }).click()
      await page.getByRole('button', { name: '下一步', exact: true }).click()
      await page.getByRole('button', { name: '立即安装', exact: true }).click()
      await page.getByRole('button', { name: '完成', exact: true }).waitFor()
    }
    await check('Fresh installation defaults to per-user scope', async () => {
      const page = await fixture()
      await finishInstall(page)
      const options = await page.evaluate(() => window.fixture.state.calls.find(call => call[0] === 'start')[1])
      assert.equal(options.forAllUsers, false)
      assert.equal(options.installDir, 'E:/fixture/user/SidekickAI-OpenSource')
      await page.close()
    })
    await check('Maintenance preserves the explicit target, scope and default data retention', async () => {
      const page = await fixture(true)
      await page.waitForFunction(() => window.fixture.state.calls.some(call => call[0] === 'read'))
      const read = await page.evaluate(() => window.fixture.state.calls.find(call => call[0] === 'read')[1])
      assert.equal(read, 'E:/fixture/custom/SidekickAI-OpenSource')
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await page.getByRole('button', { name: '开始卸载', exact: true }).click()
      const options = await page.evaluate(() => window.fixture.state.calls.find(call => call[0] === 'start')[1])
      assert.equal(options.dataStrategy, 'keep')
      assert.equal(options.forAllUsers, true)
      assert.equal(options.installDir, read)
      await page.close()
    })
    await check('System close enters confirmation before installation', async () => {
      const page = await fixture()
      assert.equal(await page.evaluate(() => typeof window.fixture.state.callbacks.close), 'function')
      await page.evaluate(() => window.fixture.state.callbacks.close())
      await page.getByText('确定要退出吗？', { exact: true }).waitFor()
      assert.equal(await page.evaluate(() => window.fixture.state.closed), false)
      await page.getByRole('button', { name: '确定退出', exact: true }).click()
      assert.equal(await page.evaluate(() => window.fixture.state.closed), true)
      await page.close()
    })
    await check('System close preserves unsaved final settings on failure and retries only once', async () => {
      const page = await fixture()
      await finishInstall(page)
      assert.equal(await page.evaluate(() => typeof window.fixture.state.callbacks.close), 'function')
      await page.evaluate(() => { window.fixture.state.flushError = true; window.fixture.state.callbacks.close() })
      await page.getByRole('alert').waitFor()
      assert.equal(await page.evaluate(() => window.fixture.state.closed), false)
      await page.screenshot({ path: path.join(evidence, 'settings-write-refusal.png') })
      await page.evaluate(() => { window.fixture.state.flushError = false; window.fixture.state.callbacks.close(); window.fixture.state.callbacks.close() })
      await page.waitForFunction(() => window.fixture.state.closed)
      const calls = await page.evaluate(() => window.fixture.state.calls)
      assert.equal(calls.filter(call => call[0] === 'flush').length, 2)
      assert.equal(calls.filter(call => call[0] === 'close').length, 1)
      assert.equal(calls.at(-1)[0], 'close')
      await page.close()
    })
    await check('A rejected operation can be closed without another cancellation loop', async () => {
      const page = await fixture()
      await page.evaluate(() => { window.fixture.state.startError = true })
      await page.getByRole('button', { name: '下一步', exact: true }).click()
      await page.getByRole('button', { name: '下一步', exact: true }).click()
      await page.getByRole('button', { name: '立即安装', exact: true }).click()
      await page.locator('.error-box').filter({ hasText: 'start refused' }).waitFor()
      await page.getByTitle('关闭', { exact: true }).click()
      await page.getByRole('button', { name: '确定退出', exact: true }).click()
      assert.equal(await page.evaluate(() => window.fixture.state.closed), true)
      await page.close()
    })
    report.ok = report.failures.length === 0
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
}

run().catch(error => { report.failures.push({ error: error.stack }); report.ok = false }).finally(() => {
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
})
