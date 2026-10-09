'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const test = require('node:test')
const { actionPlan, executePlan, menuEntries, parseArgs, readContext } = require('./workspace-menu.cjs')

function context(editionId) {
  const current = readContext()
  return { ...current, editionId, edition: current.product.editions[editionId] }
}

test('software menus expose portable and payload builds independently of official distribution policy', () => {
  for (const id of ['concept', 'community']) {
    const current = context(id)
    assert.deepEqual(menuEntries(current, 'main').map(([key, label]) => [key, label]), [
      ['1', '启动开发'], ['2', '验证'], ['3', '生成软件包'], ['4', '预览构建'], ['5', '更多工具'], ['0', '退出'],
    ])
    const modes = menuEntries(current, 'build').filter(([, , action]) => action === 'build').map(([, , , mode]) => mode)
    assert.deepEqual(modes, ['portable', 'payload', 'all', ...(id === 'concept' ? ['installer', 'complete'] : [])])
    assert.equal(menuEntries(current, 'tools').some(([, , action]) => /installer|keys|plugin/.test(action)), false)
    for (const menu of ['verify', 'build', 'tools']) {
      for (const [, , action, mode] of menuEntries(current, menu)) {
        if (action !== 'back') assert.ok(actionPlan(current, action, mode ?? null).length)
      }
    }
  }
})

test('software menus reject unavailable tools and keep community maintenance separate', () => {
  for (const mode of ['server', 'unknown']) assert.throws(() => actionPlan(context('concept'), 'build', mode))
  for (const mode of ['installer', 'complete']) {
    assert.deepEqual(actionPlan(context('concept'), 'build', mode)[0].args, ['scripts/build-distribution.cjs', '--mode', mode])
    assert.throws(() => actionPlan(context('community'), 'build', mode))
  }
  for (const action of ['installer-dev', 'verify-installer', 'plugin-preview', 'keys-dev', 'build-keys']) assert.throws(() => actionPlan(context('concept'), action))
  assert.throws(() => actionPlan(context('concept'), 'publish'))
  assert.throws(() => actionPlan(context('concept'), 'dev', 'installer'))
})

test('build aliases preserve explicit candidate and preflight behavior', () => {
  for (const id of ['concept', 'community']) {
    const current = context(id)
    assert.deepEqual(actionPlan(current, 'build-release'), actionPlan(current, 'build', 'all'))
    assert.deepEqual(actionPlan(current, 'preflight-release')[0].args, ['scripts/build-distribution.cjs', '--mode', 'all', '--preflight'])
  }
  assert.deepEqual(actionPlan(context('concept'), 'build', 'portable')[0].args, ['scripts/build-distribution.cjs', '--mode', 'portable'])
  assert.deepEqual(actionPlan(context('concept'), 'build')[0].args, ['scripts/build-distribution.cjs', '--mode', 'all'])
  assert.deepEqual(actionPlan(context('concept'), 'build', 'payload')[0].args, ['scripts/build-distribution.cjs', '--mode', 'payload'])
})

test('quick verification does not start desktop or native build regressions', () => {
  for (const id of ['concept', 'community']) {
    const plan = actionPlan(context(id), 'verify')
    assert.ok(plan.some(command => command.args.includes('product:check')))
    assert.ok(plan.some(command => command.args.includes('shared:check')))
    assert.ok(plan.some(command => command.args.includes('typecheck')))
    assert.equal(plan.some(command => command.args.some(arg => /test:desktop|test:reliability|test:installers/.test(arg))), false)
    assert.deepEqual(actionPlan(context(id), 'verify-packaging')[0].args, ['run', 'test:distribution'])
  }
})

test('argument errors fail before command execution', () => {
  for (const args of [['--mode'], ['dev', '--mode', 'installer'], ['build', '--mode', 'portable', '--mode', 'installer'], ['build', '--publish'], ['dev', 'preview']]) {
    assert.throws(() => parseArgs(args))
  }
  assert.deepEqual(parseArgs(['build', '--mode', 'portable', '--dry-run']), { action: 'build', mode: 'portable', dryRun: true, help: false })
})

test('dry run prints the full command plan without spawning a child', () => {
  const output = []
  const plan = actionPlan(context('concept'), 'verify-desktop')
  const code = executePlan(plan, { dryRun: true, output: value => output.push(value), spawn: () => { throw new Error('unexpected child') } })
  assert.equal(code, 0)
  assert.ok(output.some(line => line.includes('test:desktop')))
  assert.ok(output.some(line => line.includes('--maxWorkers=4')))
  assert.ok(output.some(line => line.includes(context('concept').root)))
})

test('execution uses argv and preserves the first child failure code', () => {
  const plan = actionPlan(context('concept'), 'verify')
  const calls = []
  const code = executePlan(plan, { npmCli: 'C:/Node Space/npm-cli.js', output: () => {}, spawn: (file, args, options) => {
    calls.push({ file, args, options })
    return { status: calls.length === 2 ? 17 : 0 }
  } })
  assert.equal(code, 17)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].file, process.execPath)
  assert.deepEqual(calls[0].args, ['C:/Node Space/npm-cli.js', 'run', 'product:check'])
  assert.equal(calls[0].options.shell, false)
  assert.equal(calls[0].options.cwd, context('concept').root)
  assert.equal(executePlan(plan, { npmCli: 'npm-cli.js', output: () => {}, spawn: () => ({ error: new Error('missing child') }) }), 1)
})

test('help and command previews work from another current directory', () => {
  const script = path.join(__dirname, 'workspace-menu.cjs')
  for (const args of [['--help'], ['build-release', '--dry-run'], ['preflight-release', '--dry-run']]) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: os.tmpdir(), encoding: 'utf8', windowsHide: true, shell: false })
    assert.equal(result.status, 0, result.stderr)
    if (args.includes('--dry-run')) assert.match(result.stdout, /build-distribution\.cjs/)
  }
  const invalid = spawnSync(process.execPath, [script, 'unknown'], { encoding: 'utf8', windowsHide: true, shell: false })
  assert.equal(invalid.status, 2)
})

test('interactive navigation visits submenus and exits without running actions', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'workspace-menu.cjs')], {
    cwd: os.tmpdir(), input: '2\n0\n3\n0\n5\n0\n0\n', encoding: 'utf8', windowsHide: true, shell: false,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /快速检查/)
  assert.match(result.stdout, /绿色 ZIP|安装器/)
  assert.match(result.stdout, /安装锁定依赖/)
  assert.doesNotMatch(result.stdout, /\[目录\]/)
})
