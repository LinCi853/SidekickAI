'use strict'

// 磁盘硬性要求：build/ 总占用不得超过 35 GiB。
// 清理阶梯：旧分发运行目录（每个版本保留最新 1 个）→ 测试残留（48 小时未改动，或同一组超过 64 个时只留最新 64 个）
// → 可再生缓存（命中预算即停）。
// 仍超预算时以退出码 1 失败；--dry-run 只报告不删除。

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const BUILD = path.join(ROOT, 'build')
const BUDGET = 35 * 1024 ** 3
const KEEP_RUNS = 1
const KEEP_TEST_ENTRIES = 64
const TEST_MAX_AGE_MS = 48 * 3600 * 1000
const VERSION_PATTERN = /\d{8}|v?\d+\.\d+\.\d+/
const ASSET_TEST_GROUP = 'asset-ipc-test-*'
// native-startup 是可复用的编译产物（build-startup-helper.cjs 靠它判定复用），
// 不能按"48 小时未改动"当测试残留删掉，只在超预算时作为可再生缓存处理。
const FIXED_TEST_NAMES = ['test-fixtures', 'version-tests', 'local-build-config-tests']
const PURGEABLE_CACHES = [
  'component-cache',
  'native-minimum',
  'native-minimum-addon',
  'native-startup',
  'shared-components',
]

function dirSize(directory) {
  let total = 0
  const walk = (current) => {
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) walk(target)
      else if (entry.isFile()) {
        try {
          total += fs.statSync(target).size
        } catch {
          /* raced */
        }
      }
    }
  }
  walk(directory)
  return total
}

// 所有删除都必须落在 build/ 内部：既不删除 build/ 本身，也不跟随调用者的 cwd。
function confineToBuild(target) {
  const relative = path.relative(BUILD, path.resolve(target))
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error(`[budget] Refusing to delete outside build/: ${target}`)
}

function remove(target, dryRun) {
  confineToBuild(target)
  // 重解析点（junction / 符号链接）本身不是"build/ 内的数据"：
  // rmSync 递归会跟随它删到链接目标里去，所以只断开链接本身。
  let link = false
  try {
    link = fs.lstatSync(target).isSymbolicLink()
  } catch {
    return 0
  }
  const size = link ? 0 : dirSize(target)
  if (!dryRun) {
    if (link) fs.unlinkSync(target)
    else fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 })
  }
  return size
}

function subdirs(directory) {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(directory, entry.name))
  } catch {
    return []
  }
}

function modifiedAt(target) {
  try {
    return fs.statSync(target).mtimeMs
  } catch {
    return 0
  }
}

// 版本键：保留名称里日期/版本号之前的通道前缀（release / ui / verification …），
// 再拼上 8 位日期或 1.2.3 形式的版本号。这样同一天的 release 运行目录
// 不会被更新的 ui 运行目录顶掉——两者是不同用途，不能互相取代。
// 无法识别版本的目录名统一归到 unknown 组，否则它们各自成组、slice(1) 为空，会永远不被清理。
function versionKey(name) {
  const match = VERSION_PATTERN.exec(name)
  if (!match) return 'unknown'
  const channel = name.slice(0, match.index).replace(/[-_.]+$/, '')
  return channel ? `${channel}|${match[0]}` : match[0]
}

// 测试残留分组：asset-ipc-test-* 是一组；固定名称各自成组（只适用时间规则）。
function testGroup(name) {
  if (name.startsWith('asset-ipc-test-')) return ASSET_TEST_GROUP
  return FIXED_TEST_NAMES.includes(name) ? name : undefined
}

const gib = (bytes) => (bytes / 1024 ** 3).toFixed(2) + ' GiB'

function main(args) {
  const dryRun = args.includes('--dry-run')
  if (!fs.existsSync(BUILD)) {
    console.log('[budget] No build directory')
    return
  }
  const before = dirSize(BUILD)
  let freed = 0
  const prune = (target, label) => {
    freed += remove(target, dryRun)
    console.log(`[budget] ${dryRun ? 'would remove' : 'removed'} ${label}`)
  }

  // 1. 分发运行目录：每个 edition 内按版本分组，每个版本只保留最新 1 个
  for (const edition of subdirs(path.join(BUILD, 'distribution-runs'))) {
    const byVersion = new Map()
    for (const run of subdirs(edition)) {
      const key = versionKey(path.basename(run))
      if (!byVersion.has(key)) byVersion.set(key, [])
      byVersion.get(key).push(run)
    }
    for (const [key, runs] of byVersion) {
      runs.sort((a, b) => modifiedAt(b) - modifiedAt(a))
      for (const stale of runs.slice(KEEP_RUNS))
        prune(
          stale,
          `distribution run ${path.relative(BUILD, stale).replaceAll('\\', '/')} (version ${key})`,
        )
    }
  }

  // 2. 测试残留：超过 48 小时未改动即删除；asset-ipc-test-* 同一组超过 64 个时只保留最新的 64 个
  const groups = new Map()
  for (const entry of subdirs(BUILD)) {
    const group = testGroup(path.basename(entry))
    if (!group) continue
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(entry)
  }
  for (const [group, entries] of groups) {
    const expired = new Set(
      entries.filter((entry) => Date.now() - modifiedAt(entry) > TEST_MAX_AGE_MS),
    )
    if (group === ASSET_TEST_GROUP && entries.length > KEEP_TEST_ENTRIES) {
      for (const entry of [...entries]
        .sort((a, b) => modifiedAt(b) - modifiedAt(a))
        .slice(KEEP_TEST_ENTRIES))
        expired.add(entry)
    }
    for (const entry of entries)
      if (expired.has(entry)) prune(entry, `test output ${path.basename(entry)}`)
  }

  // 3. 仍超预算：清空可再生缓存，命中预算即停（按体积从大到小，避免删了小缓存仍不够）
  let after = dryRun ? before - freed : dirSize(BUILD)
  if (after > BUDGET) {
    const caches = PURGEABLE_CACHES.map((name) => ({ name, target: path.join(BUILD, name) }))
      .filter((entry) => fs.existsSync(entry.target))
      .map((entry) => ({ ...entry, size: dirSize(entry.target) }))
      .sort((a, b) => b.size - a.size)
    for (const cache of caches) {
      if (after <= BUDGET) break
      prune(cache.target, `cache to meet budget ${cache.name}`)
      after = dryRun ? before - freed : dirSize(BUILD)
    }
  }

  // 实测而非估算：force:true 会静默吞掉 EBUSY/EPERM，
  // 用 before - freed 记账会把"删失败"报成"已释放"，正好掩盖硬性预算违规。
  const now = dryRun ? before - freed : dirSize(BUILD)
  console.log(
    `[budget] build/ before ${gib(before)}${dryRun ? ' (dry-run)' : ''}, freed ${gib(freed)}, now ${gib(now)}, budget ${gib(BUDGET)}`,
  )
  if (now > BUDGET) {
    console.error(`[budget] HARD LIMIT EXCEEDED: build/ is ${gib(now)} > ${gib(BUDGET)}`)
    process.exitCode = 1
  }
}

module.exports = { dirSize, BUDGET }
if (require.main === module) main(process.argv.slice(2))
