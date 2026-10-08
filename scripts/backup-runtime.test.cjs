const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const esbuild = require('esbuild')

test('concept application restores archives through its installed and portable startup adapters', { timeout: 120000 }, async () => {
  const workspace = path.resolve(__dirname, '..')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'concept-backup-runtime-'))
  const server = http.createServer((_request, response) => response.end('<!doctype html><title>Isolated restore fixture</title>'))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const common = { bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3', 'adm-zip'], logLevel: 'silent' }
  let passed = false
  try {
    for (const name of ['better-sqlite3', 'adm-zip']) {
      const moduleDirectory = path.join(directory, 'node_modules', name)
      fs.mkdirSync(moduleDirectory, { recursive: true })
      fs.writeFileSync(path.join(moduleDirectory, 'index.js'), `module.exports = require(${JSON.stringify(require.resolve(name))})`)
    }
    await esbuild.build({ ...common, entryPoints: [path.join(workspace, 'electron/runtime-environment.ts')], outfile: path.join(directory, 'startup.cjs') })
    await esbuild.build({ ...common,
      stdin: { contents: `export * from './electron/store/backup-restore'; export * from './electron/store/module-state-store'; export * from './electron/utils/app-crypto'; export * from './packages/backup-core/sessions'; export * from './packages/backup-core/sensitive-drafts'; export * from './packages/backup-core/transaction';`, resolveDir: workspace },
      outfile: path.join(directory, 'backup.cjs'),
      plugins: [{ name: 'isolate-window-services', setup(build) {
        build.onResolve({ filter: /edition-runtime\.js$/ }, () => ({ path: 'handoff', namespace: 'isolated-handoff' }))
        build.onLoad({ filter: /.*/, namespace: 'isolated-handoff' }, () => ({ contents: 'export const prepareDataRestoreHandoff = async () => () => {};' }))
        build.onResolve({ filter: /(?:modules\/registry|chat-store|whiteboard-db|notes-db|bookmark-store|profile-store)\.js$/ }, args => ({ path: args.path, namespace: 'isolated-stores' }))
        build.onLoad({ filter: /.*/, namespace: 'isolated-stores' }, () => ({ contents: 'export const closeChatStore=()=>{}; export const closeWhiteboardDb=()=>{}; export const closeNotesDb=()=>{}; export const closeBookmarkStore=()=>{}; export const profileStore={list:()=>[]}; export const collectModuleDataFiles=()=>({dbFiles:[],assetDirs:[]}); export const closeAllModuleDbs=()=>{};' }))
      } }],
    })
    fs.copyFileSync(path.join(__dirname, 'fixtures/backup-runtime.cjs'), path.join(directory, 'runtime.cjs'))
    const run = (mode, item, sourceLayout = item.layout, archive = path.join(item.base, 'backup.sabackup')) => new Promise((resolve, reject) => {
      const env = { ...process.env, SIDEKICK_BACKUP_JOB_ROOT: path.join(directory, 'jobs') }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.SIDEKICK_DATA_DIR
      const child = spawn(require('electron'), [path.join(directory, 'runtime.cjs'), `--mode=${mode}`, `--root=${item.base}`, `--layout=${item.layout}`, `--program=${item.program}`, `--source-layout=${sourceLayout}`, `--archive=${archive}`, `--origin=${origin}`, '--disable-gpu', '--disable-crashpad'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', chunk => { output += chunk })
      child.stderr.on('data', chunk => { output += chunk })
      const timeout = setTimeout(() => child.kill(), 18000)
      child.once('error', error => { clearTimeout(timeout); reject(error) })
      child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`${item.layout} ${mode} failed (${code}): ${output}`)) })
    })
    const layouts = ['installed', 'portable'].map(layout => {
      const base = path.join(directory, layout), program = path.join(base, 'program')
      const sentinel = path.join(base, 'roaming', 'sidekick-ai', 'community-sentinel.txt')
      fs.mkdirSync(program, { recursive: true })
      fs.mkdirSync(path.dirname(sentinel), { recursive: true })
      fs.writeFileSync(sentinel, layout)
      fs.writeFileSync(path.join(program, 'SidekickAI.exe'), 'isolated executable identity')
      if (layout === 'portable') fs.writeFileSync(path.join(program, 'portable.txt'), 'AI Window Portable Mode Marker\n')
      return { layout, base, program, sentinel }
    })
    for (const item of layouts) for (const mode of ['export', 'restore', 'verify']) {
      if (item.layout === 'portable' && mode === 'restore') {
        const moved = path.join(item.base, 'moved program')
        fs.renameSync(item.program, moved); item.program = moved
      }
      await run(mode, item)
      assert.equal(fs.readFileSync(path.join(item.base, `${mode}.ok`), 'utf8'), 'ok')
      for (const entry of layouts) assert.equal(fs.readFileSync(entry.sentinel, 'utf8'), entry.layout)
    }
    for (const item of layouts) {
      const other = layouts.find(entry => entry !== item)
      for (const mode of ['import', 'restore', 'verify']) {
        await run(mode, item, other.layout, path.join(other.base, 'backup.sabackup'))
        assert.equal(fs.readFileSync(path.join(item.base, `${mode}.ok`), 'utf8'), 'ok')
        for (const entry of layouts) assert.equal(fs.readFileSync(entry.sentinel, 'utf8'), entry.layout)
      }
    }
    passed = true
  } finally {
    server.close()
    assert.equal(path.dirname(directory), os.tmpdir())
    assert(path.basename(directory).startsWith('concept-backup-runtime-'))
    if (passed) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    else console.error(`Preserved isolated fixture: ${directory}`)
  }
})
