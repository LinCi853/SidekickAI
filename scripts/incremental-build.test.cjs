'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const application = require('./application-build.cjs')
const cache = require('./build-cache.cjs')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-incremental-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('compilation skips identical inputs and rebuilds corrupted outputs or changed dependencies', t => {
  const root = fixture(t)
  const write = (file, bytes) => {
    const destination = path.join(root, file)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, bytes)
  }
  for (const dir of ['electron', 'src', 'resources', 'packages/product-contract', 'packages/desktop-common', 'packages/backup-core', 'packages/resource-contract', 'electron/shared']) fs.mkdirSync(path.join(root, dir), { recursive: true })
  for (const file of ['product-edition.json', 'package.json', 'electron.vite.config.ts', 'scripts/compilation-inputs.ts', 'tsconfig.json', 'tsconfig.node.json']) write(file, '{}')
  write('package-lock.json', JSON.stringify({ packages: { 'node_modules/runtime': {} } }))
  write('node_modules/runtime/package.json', '{}')
  write('node_modules/runtime/dist/index.js', 'first dependency')
  write('node_modules/esbuild/package.json', '{}')
  write('node_modules/esbuild/dist/tool.js', 'first tool')
  write('electron/shared/used.mjs', 'first shared source')
  write('scripts/excalidraw-clipboard-feedback.ts', 'first clipboard adapter')
  write('scripts/renderer-security.ts', 'first renderer policy adapter')
  write('scripts/build-startup-helper.cjs', 'startup recipe')
  write('tools/startup-helper/StartupHelper.cs', 'startup driver')
  let builds = 0
  const run = () => {
    builds++
    for (const target of ['main', 'preload', 'renderer']) {
      write(`out/${target}/index.js`, fs.readFileSync(path.join(root, 'node_modules/runtime/dist/index.js')))
      const modules = ['node_modules/runtime/dist/index.js', 'electron/shared/used.mjs'].filter(file => fs.existsSync(path.join(root, file)))
      write(`out/${target}/compilation-inputs.json`, JSON.stringify({ schemaVersion: 1, target, modules, outputs: [] }))
    }
  }
  const compile = () => application.compile(path.join(root, 'evidence'), run, root, path.join(root, 'cache'))
  const first = compile()
  assert.equal(builds, 1)
  assert.equal(compile().outputFingerprint, first.outputFingerprint)
  assert.equal(builds, 1)
  fs.rmSync(path.join(root, 'out'), { recursive: true })
  compile()
  assert.equal(builds, 1)
  write('node_modules/runtime/dist/index.js', 'second dependency')
  compile()
  assert.equal(builds, 2)
  write('electron/shared/used.mjs', 'second shared source')
  compile()
  assert.equal(builds, 3)
  fs.rmSync(path.join(root, 'electron/shared/used.mjs'))
  compile()
  assert.equal(builds, 4)
  const current = compile()
  const record = JSON.parse(fs.readFileSync(path.join(root, 'cache/application-build', `${current.key}.json`)))
  fs.writeFileSync(path.join(record.value.directory, 'main/index.js'), 'corrupt')
  compile()
  assert.equal(builds, 5)
  assert.equal(cache.inspect('application-build', current.key, path.join(root, 'cache')).reason, 'matched')
  write('node_modules/esbuild/dist/tool.js', 'second tool')
  assert.notEqual(compile().key, first.key)
  assert.equal(builds, 6)
  const previous = process.env.SIDEKICK_REBUILD_ALL
  process.env.SIDEKICK_REBUILD_ALL = '1'
  try { compile(); assert.equal(builds, 7) } finally {
    if (previous === undefined) delete process.env.SIDEKICK_REBUILD_ALL
    else process.env.SIDEKICK_REBUILD_ALL = previous
  }
  const beforeBackup = compile().key
  write('packages/backup-core/compatibility.ts', 'export const schema = 2')
  assert.notEqual(compile().key, beforeBackup)
  assert.equal(builds, 8)
  const beforeConfig = compile().key
  write('tsconfig.json', '{"compilerOptions":{"target":"ES2022"}}')
  assert.notEqual(compile().key, beforeConfig)
  assert.equal(builds, 9)
  const beforeClipboard = compile().key
  write('scripts/excalidraw-clipboard-feedback.ts', 'second clipboard adapter')
  assert.notEqual(compile().key, beforeClipboard)
  assert.equal(builds, 10)
  const beforeStartup = compile().key
  write('tools/startup-helper/StartupHelper.cs', 'changed startup driver')
  assert.notEqual(compile().key, beforeStartup)
  assert.equal(builds, 11)
  const beforePolicy = compile().key
  write('scripts/renderer-security.ts', 'second renderer policy adapter')
  assert.notEqual(compile().key, beforePolicy)
  assert.equal(builds, 12)
  const beforeTheme = compile().key
  write('src/public/theme-startup.js', 'changed initial theme')
  assert.notEqual(compile().key, beforeTheme)
  assert.equal(builds, 13)
  const beforeOrigin = compile().key
  write('packages/resource-contract/service-origin.mjs', 'service origin validation')
  assert.notEqual(compile().key, beforeOrigin)
  assert.equal(builds, 14)
})
