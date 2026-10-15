'use strict'

// 磁盘硬性要求：build/ 总占用不得超过 15 GiB。
// 清理阶梯：旧分发运行目录（每版保留最新 1 个）→ 48 小时外的测试残留 → 可再生缓存。
// 仍超预算时以退出码 1 失败；--dry-run 只报告不删除。

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const BUILD = path.join(ROOT, 'build')
const BUDGET = 15 * 1024 ** 3
const KEEP_RUNS = 1
const TEST_MAX_AGE_MS = 48 * 3600 * 1000

function dirSize(directory) {
  let total = 0
  const walk = current => {
    let entries
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) walk(target)
      else if (entry.isFile()) { try { total += fs.statSync(target).size } catch { /* raced */ } }
    }
  }
  walk(directory)
  return total
}

function remove(target, dryRun) {
  const size = dirSize(target)
  if (!dryRun) fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 })
  return size
}

function subdirs(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(directory, entry.name))
  } catch { return [] }
}

function main(args) {
  const dryRun = args.includes('--dry-run')
  if (!fs.existsSync(BUILD)) { console.log('[budget] No build directory'); return }
  const before = dirSize(BUILD)
  let freed = 0

  // 1. 分发运行目录：每个 edition 子目录内按最近写入保留最新 N 个
  for (const edition of subdirs(path.join(BUILD, 'distribution-runs'))) {
    const runs = subdirs(edition).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    for (const stale of runs.slice(KEEP_RUNS)) {
      freed += remove(stale, dryRun)
      console.log('[budget] removed distribution run', path.relative(BUILD, stale).replaceAll('\\', '/'))
    }
  }

  // 2. 测试残留：asset-ipc-test-*、test-fixtures、version-tests 等超过 48 小时的条目
  const testPatterns = name => /^asset-ipc-test-/.test(name)
    || ['test-fixtures', 'version-tests', 'local-build-config-tests', 'native-startup'].includes(name)
  for (const entry of subdirs(BUILD)) {
    const name = path.basename(entry)
    if (name === 'distribution-runs') continue
    if (testPatterns(name) && Date.now() - fs.statSync(entry).mtimeMs > TEST_MAX_AGE_MS) {
      freed += remove(entry, dryRun)
      console.log('[budget] removed stale test output', name)
    }
  }

  // 3. 仍超预算：清空可再生缓存
  let after = before - freed
  if (after > BUDGET) {
    for (const name of ['component-cache', 'native-startup']) {
      const target = path.join(BUILD, name)
      if (fs.existsSync(target)) {
        freed += remove(target, dryRun)
        console.log('[budget] removed cache to meet budget', name)
        after = before - freed
        if (after <= BUDGET) break
      }
    }
  }

  after = dirSize(BUILD)
  const gib = bytes => (bytes / 1024 ** 3).toFixed(2) + ' GiB'
  console.log(`[budget] build/ before ${gib(before)}${dryRun ? ' (dry-run)' : ''}, freed ${gib(freed)}, now ${gib(after)}, budget ${gib(BUDGET)}`)
  if (after > BUDGET) {
    console.error(`[budget] HARD LIMIT EXCEEDED: build/ is ${gib(after)} > ${gib(BUDGET)}`)
    process.exitCode = 1
  }
}

module.exports = { dirSize, BUDGET }
if (require.main === module) main(process.argv.slice(2))
