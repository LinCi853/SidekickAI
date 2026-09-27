'use strict'

const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const { spawnSync } = require('node:child_process')
const { rootPackageVersion } = require('./sync-versions.cjs')

const workspace = path.resolve(__dirname, '..')

function readContext(root = workspace) {
  const product = { ...JSON.parse(fs.readFileSync(path.join(root, 'packages/product-contract/manifest.json'), 'utf8')), version: rootPackageVersion(root) }
  const selection = JSON.parse(fs.readFileSync(path.join(root, 'product-edition.json'), 'utf8'))
  const edition = product.editions[selection.edition]
  if (!edition || !Array.isArray(edition.packageKinds)) throw new Error('产品路线或分发配置无效。')
  return { root, product, edition, editionId: selection.edition }
}

function parseArgs(args) {
  const result = { action: null, mode: null, dryRun: false, help: false }
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--help' || value === '-h') result.help = true
    else if (value === '--dry-run') result.dryRun = true
    else if (value === '--mode') {
      if (result.mode !== null || !args[index + 1] || args[index + 1].startsWith('-')) throw new Error('--mode 需要且只能提供一个包型。')
      result.mode = args[++index]
    } else if (!value.startsWith('-') && result.action === null) result.action = value
    else throw new Error(`不支持的参数：${value}`)
  }
  if (result.mode !== null && !['build', 'build-release', 'preflight-release'].includes(result.action)) throw new Error('--mode 只用于构建或构建预检。')
  return result
}

function buildModes(context) {
  const modes = context.edition.packageKinds.filter(kind => ['installer', 'portable'].includes(kind))
  if (modes.includes('installer') && modes.includes('portable')) modes.push('all')
  return modes
}

function actionPlan(context, action, mode = null) {
  const root = context.root
  const npm = (args, directory = root, env = {}) => ({ tool: 'npm', args, directory, env })
  const node = (args) => ({ tool: 'node', args, directory: root, env: {} })
  const communityOnly = ['plugin-preview', 'keys-dev', 'build-keys']
  if (communityOnly.includes(action) && context.editionId !== 'community') throw new Error('此工具只属于社区版工作区。')
  if (['build', 'build-release', 'preflight-release'].includes(action)) {
    const selected = mode || 'installer'
    if (!buildModes(context).includes(selected)) throw new Error(`当前版本不分发 ${selected}，请选择允许的包型。`)
    return [node(['scripts/build-distribution.cjs', '--mode', selected, ...(action === 'preflight-release' ? ['--preflight'] : [])])]
  }
  if (mode !== null) throw new Error('此操作不接受包型。')
  switch (action) {
    case 'dev': return [npm(['run', 'dev'])]
    case 'preview': return [npm(['run', 'preview'])]
    case 'devtools': return [npm(['run', 'dev'], root, { DEV_TOOLS: '1' })]
    case 'dependencies': return [npm(['ci'])]
    case 'installer-dev': return [npm(['run', 'tauri', '--', 'dev'], path.join(root, 'installer-tauri'))]
    case 'plugin-preview': return [npm(['run', 'preview:plugins'])]
    case 'keys-dev': return [npm(['run', 'tauri', '--', 'dev'], path.join(root, 'tools/oxy-key-manager'))]
    case 'build-keys': return [npm(['run', 'build:oxy-key-manager'])]
    case 'verify': return [
      npm(['run', 'product:check']), npm(['run', 'shared:check']), npm(['run', 'typecheck']),
      node(['--test', 'scripts/workspace-menu.test.cjs']),
    ]
    case 'verify-desktop': return context.editionId === 'concept'
      ? [npm(['test', '--', '--maxWorkers=4', '--minWorkers=1']), npm(['run', 'test:desktop'])]
      : [npm(['run', 'test:reliability', '--', '--maxWorkers=4', '--minWorkers=1'])]
    case 'verify-installer': return [npm(['run', 'test:installers'])]
    default: throw new Error(`未知操作：${action}`)
  }
}

function findNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.join(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ]
  try { candidates.push(path.join(path.dirname(require.resolve('npm/package.json')), 'bin/npm-cli.js')) } catch {}
  const found = candidates.find(candidate => candidate && path.basename(candidate) === 'npm-cli.js' && fs.existsSync(candidate))
  if (!found) throw new Error('找不到 npm-cli.js，请安装包含 npm 的 Node.js，或在 npm 环境中启动此入口。')
  return path.resolve(found)
}

function executePlan(plan, options = {}) {
  const output = options.output || console.log
  const spawn = options.spawn || spawnSync
  for (const command of plan) {
    const shown = command.tool === 'npm' ? ['npm', ...command.args] : ['node', ...command.args]
    output(`[目录] ${command.directory}`)
    if (Object.keys(command.env).length) output(`[环境] ${JSON.stringify(command.env)}`)
    output(shown.map(value => JSON.stringify(value)).join(' '))
    if (options.dryRun) continue
    const args = command.tool === 'npm' ? [options.npmCli || findNpmCli(), ...command.args] : command.args
    const env = { ...process.env, ...command.env }
    env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/'
    env.ELECTRON_BUILDER_BINARIES_MIRROR ||= 'https://npmmirror.com/mirrors/electron-builder-binaries/'
    const result = spawn(process.execPath, args, { cwd: command.directory, env, stdio: 'inherit', windowsHide: true, shell: false })
    if (result.error) { output(`执行失败：${result.error.message}`); return 1 }
    if (result.status !== 0) return result.status ?? (result.signal === 'SIGINT' ? 130 : 1)
  }
  return 0
}

function menuEntries(context, menu) {
  if (menu === 'main') return [
    ['1', context.editionId === 'concept' ? '启动工具' : '启动开发', 'dev'], ['2', '验证', 'verify-menu'], ['3', context.editionId === 'concept' ? '生成安装包' : '构建候选', 'build-menu'],
    ['4', '预览构建', 'preview'], ['5', '更多工具', 'tools-menu'], ['0', '退出', 'exit'],
  ]
  if (menu === 'verify') return [
    ['1', '快速检查（配置、类型、菜单）', 'verify'],
    ['2', '桌面完整回归（隔离数据，会启动应用）', 'verify-desktop'],
    ['3', '安装卸载回归（原生编译、隔离目标）', 'verify-installer'], ['0', '返回', 'back'],
  ]
  if (menu === 'build') {
    const labels = { installer: '安装器', portable: '绿色 ZIP', all: '两者一起构建' }
    return [...buildModes(context).map((mode, index) => [String(index + 1), labels[mode], 'build', mode]), ['0', '返回', 'back']]
  }
  if (menu === 'tools') return [
    ['1', '开发并打开调试工具', 'devtools'], ['2', '安装锁定依赖', 'dependencies'], ['3', '安装器开发', 'installer-dev'],
    ...(context.editionId === 'community' ? [
      ['4', '隔离插件预览', 'plugin-preview'], ['5', '密钥工具开发', 'keys-dev'], ['6', '构建密钥工具（更新稳定入口）', 'build-keys'],
    ] : []), ['0', '返回', 'back'],
  ]
  throw new Error(`未知菜单：${menu}`)
}

function help(context) {
  const concept = context.editionId === 'concept'
  return [
    `工百窗 / SidekickAI ${context.product.version} 工作区入口`,
    '无参数显示菜单：' + menuEntries(context, 'main').map(([key, label]) => `${key} ${label}`).join('；') + '。',
    '用法：launch.bat <操作> [--mode <包型>] [--dry-run]',
    concept ? '推荐通过 launch.bat 启动；首次使用请选择「更多工具 → 安装锁定依赖」，完成后选择「启动工具」。' : '也可运行 node scripts/workspace-menu.cjs，工作目录由脚本位置确定。',
    '操作：dev、verify、build、preview、devtools、dependencies、installer-dev。',
    'verify 为快速检查；verify-desktop 启动隔离桌面回归；verify-installer 编译并运行隔离安装卸载回归。',
    ...(context.editionId === 'community' ? ['社区工具：plugin-preview、keys-dev、build-keys。'] : []),
    `允许包型：${buildModes(context).join('、')}；build 默认 installer。`,
    concept ? 'build-release 生成安装器；preflight-release 检查构建条件。' : '兼容入口：build-release 构建安装器候选；preflight-release 仅执行安装器构建预检。',
    '--dry-run 只显示目录、环境和参数，不运行命令；不带操作时预览各菜单。',
    concept ? '生成的文件保存在本机，不会自动上传或替换已有安装。' : '候选构建不发布、不上传、不替换个人安装；原生构建预检可能产生探测文件。',
    ...(concept ? [] : ['社区版不接受 portable 或 all；绿色包不会被静默改成安装器。']),
  ].join('\n')
}

async function interactive(context) {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout })
  const lines = terminal[Symbol.asyncIterator]()
  let menu = 'main'
  let lastCode = 0
  try {
    for (;;) {
      console.log(`\n工百窗 / SidekickAI ${context.product.version}`)
      console.log(`工作区：${context.root}`)
      const entries = menuEntries(context, menu)
      for (const [key, label] of entries) console.log(`  [${key}] ${label}`)
      process.stdout.write('请选择：')
      const line = await lines.next()
      if (line.done) return lastCode
      const entry = entries.find(([key]) => key === line.value.trim())
      if (!entry) { console.error('选项无效，请重新选择。'); continue }
      const [, , action, mode] = entry
      if (action === 'exit') return lastCode
      if (action === 'back') { menu = 'main'; continue }
      if (action.endsWith('-menu')) { menu = action.slice(0, -5); continue }
      terminal.pause()
      try { lastCode = executePlan(actionPlan(context, action, mode ?? null)) }
      catch (error) { console.error(error.message); lastCode = 1 }
      finally { terminal.resume() }
      if (lastCode !== 0) console.error(`操作失败（退出码 ${lastCode}），请查看上方输出。`)
    }
  } finally { terminal.close() }
}

async function main(args = process.argv.slice(2)) {
  try {
    const options = parseArgs(args)
    const context = readContext()
    if (options.help) { console.log(help(context)); return 0 }
    if (options.action) return executePlan(actionPlan(context, options.action, options.mode), options)
    if (options.dryRun) {
      console.log(help(context))
      for (const menu of ['main', 'verify', 'build', 'tools']) {
        console.log(`\n${{ main: '主菜单', verify: '验证', build: context.editionId === 'concept' ? '生成安装包' : '构建候选', tools: '更多工具' }[menu]}`)
        for (const [key, label, action, mode] of menuEntries(context, menu)) console.log(`  [${key}] ${label}${mode ? ` (${mode})` : ''}: ${action}`)
      }
      return 0
    }
    return await interactive(context)
  } catch (error) { console.error(error.message); return 2 }
}

module.exports = { readContext, parseArgs, buildModes, actionPlan, executePlan, menuEntries, help, main }
if (require.main === module) main().then(code => { process.exitCode = code }).catch(error => { console.error(error); process.exitCode = 1 })
