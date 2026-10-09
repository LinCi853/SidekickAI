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
  return ['portable', 'payload', 'all', ...(context.editionId === 'concept' ? ['installer', 'complete'] : [])]
}

function actionPlan(context, action, mode = null) {
  const root = context.root
  const npm = (args, directory = root, env = {}) => ({ tool: 'npm', args, directory, env })
  const node = (args) => ({ tool: 'node', args, directory: root, env: {} })
  if (['build', 'build-release', 'preflight-release'].includes(action)) {
    const selected = mode || 'all'
    if (!buildModes(context).includes(selected)) throw new Error(`当前工作区不支持 ${selected}，请选择菜单中的包型。`)
    return [node(['scripts/build-distribution.cjs', '--mode', selected, ...(action === 'preflight-release' ? ['--preflight'] : [])])]
  }
  if (mode !== null) throw new Error('此操作不接受包型。')
  switch (action) {
    case 'dev': return [npm(['run', 'dev'])]
    case 'preview': return [npm(['run', 'preview'])]
    case 'devtools': return [npm(['run', 'dev'], root, { DEV_TOOLS: '1' })]
    case 'dependencies': return [npm(['ci'])]
    case 'verify': return [
      npm(['run', 'product:check']), npm(['run', 'shared:check']), npm(['run', 'typecheck']),
      node(['--test', 'scripts/workspace-menu.test.cjs', 'scripts/shared-source.test.cjs']),
    ]
    case 'verify-desktop': return [npm(['test', '--', '--maxWorkers=4', '--minWorkers=1']), npm(['run', 'test:desktop'])]
    case 'verify-packaging': return [npm(['run', 'test:distribution'])]
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
    ['1', '启动开发', 'dev'], ['2', '验证', 'verify-menu'], ['3', '生成软件包', 'build-menu'],
    ['4', '预览构建', 'preview'], ['5', '更多工具', 'tools-menu'], ['0', '退出', 'exit'],
  ]
  if (menu === 'verify') return [
    ['1', '快速检查（配置、类型、菜单）', 'verify'],
    ['2', '桌面完整回归（隔离数据，会启动应用）', 'verify-desktop'],
    ['3', '绿色版与载荷回归（隔离目录）', 'verify-packaging'], ['0', '返回', 'back'],
  ]
  if (menu === 'build') {
    const labels = { portable: '绿色 ZIP（双架构）', payload: '标准应用载荷 ZIP（x64、ARM64）', all: '绿色版与标准载荷',
      installer: '安装器（调用二进制组件）', complete: '完整包（安装器与绿色版）' }
    return [...buildModes(context).map((mode, index) => [String(index + 1), labels[mode], 'build', mode]), ['0', '返回', 'back']]
  }
  if (menu === 'tools') return [
    ['1', '开发并打开调试工具', 'devtools'], ['2', '安装锁定依赖', 'dependencies'], ['0', '返回', 'back'],
  ]
  throw new Error(`未知菜单：${menu}`)
}

function help(context) {
  return [
    `工百窗 / SidekickAI ${context.product.version} 工作区入口`,
    '无参数显示菜单：' + menuEntries(context, 'main').map(([key, label]) => `${key} ${label}`).join('；') + '。',
    '用法：launch.bat <操作> [--mode <包型>] [--dry-run]',
    '开发建议使用 launch.bat；首次使用请选择「更多工具 → 安装锁定依赖」，完成后选择「启动开发」。',
    '操作：dev、verify、build、preview、devtools、dependencies。',
    'verify 为快速检查；verify-desktop 启动隔离桌面回归；verify-packaging 验证软件打包。',
    `允许包型：${buildModes(context).join('、')}；build 默认 all。`,
    '构建按输入摘要复用应用编译；PowerShell 中设置 $env:SIDEKICK_REBUILD_ALL="1" 可强制重建。',
    'build-release 生成绿色版与标准载荷；preflight-release 检查软件构建条件。',
    ...(context.editionId === 'concept' ? ['installer 和 complete 使用已固定版本与摘要的待组装组件，无需私有源码或官方密钥。',
      '完整包使用本机自建身份；local/self-build-identity.json 用于后续同身份构建，请保留且勿公开。',
      '可设置 SIDEKICK_DISTRIBUTION_TOOLKIT_REFERENCE 选择组件发布清单；完整包构建不会执行安装。'] : []),
    ...(context.editionId === 'concept' ? ['maintenance/installation-configuration.json 可设置安装默认值，需工具包支持配置接口；示例见同目录 .example.json。'] : []),
    '--dry-run 只显示目录、环境和参数，不运行命令；不带操作时预览各菜单。',
    '生成的文件保存在本机，不会自动上传或替换已有安装。',
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
        console.log(`\n${{ main: '主菜单', verify: '验证', build: '生成软件包', tools: '更多工具' }[menu]}`)
        for (const [key, label, action, mode] of menuEntries(context, menu)) console.log(`  [${key}] ${label}${mode ? ` (${mode})` : ''}: ${action}`)
      }
      return 0
    }
    return await interactive(context)
  } catch (error) { console.error(error.message); return 2 }
}

module.exports = { readContext, parseArgs, buildModes, actionPlan, executePlan, menuEntries, help, main }
if (require.main === module) main().then(code => { process.exitCode = code }).catch(error => { console.error(error); process.exitCode = 1 })
