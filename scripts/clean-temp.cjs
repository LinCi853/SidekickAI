'use strict'

// 清理 %TEMP% 中本项目产生的残留（安装器测试夹具、附件副本、预览、构建下载缓存等）。
// 只删 os.tmpdir() 的直接子项，且只匹配已知前缀；默认跳过最近 2 小时改动过的项，
// 避免误伤正在使用的安装/预览/下载。--dry-run 只报告不删除。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DEFAULT_MAX_AGE_MS = 2 * 3600 * 1000
// 生产卸载工作区可能在真实卸载过程中短暂存在，给更长宽限。
const WORKER_MAX_AGE_MS = 24 * 3600 * 1000

// 前缀按「本项目独有」筛选；sidekick- 覆盖历史 installer 测试场景名与运行时夹具。
const PREFIXES = [
  'SidekickAI-',
  'sidekickai-',
  'sidekick-',
  'ai-window-stt-local-',
  'electron-download-',
]

function matches(name) {
  return PREFIXES.some(prefix => name.startsWith(prefix))
}

function isWorkerDir(name) {
  return name === 'SidekickAI-Uninstall' || name.startsWith('SidekickAI-Uninstall-')
}

function entrySize(target) {
  let total = 0
  const walk = current => {
    let entries
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const child = path.join(current, entry.name)
      // 不跟随重解析点：只把链接本身记 0 字节，避免把别的目录算进来。
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(child)
      else if (entry.isFile()) { try { total += fs.statSync(child).size } catch { /* raced */ } }
    }
  }
  try {
    const stat = fs.lstatSync(target)
    if (stat.isSymbolicLink()) return 0
    if (stat.isFile()) return stat.size
    if (stat.isDirectory()) walk(target)
  } catch { return 0 }
  return total
}

function removeEntry(target, dryRun) {
  try {
    const stat = fs.lstatSync(target)
    if (!dryRun) {
      if (stat.isSymbolicLink()) fs.unlinkSync(target)
      else fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    }
    return true
  } catch {
    return false
  }
}

function collect(tempRoot) {
  let entries
  try {
    entries = fs.readdirSync(tempRoot, { withFileTypes: true })
  } catch (error) {
    console.error('[temp] Cannot read temp directory:', error.message)
    return []
  }
  return entries
    .filter(entry => matches(entry.name))
    .map(entry => {
      const target = path.join(tempRoot, entry.name)
      let mtimeMs = 0
      try { mtimeMs = fs.lstatSync(target).mtimeMs } catch { /* raced */ }
      return { name: entry.name, target, mtimeMs, isDirectory: entry.isDirectory() }
    })
}

function main(args) {
  const dryRun = args.includes('--dry-run')
  const maxAgeFlag = args.find(arg => arg.startsWith('--max-age-hours='))
  const maxAgeMs = maxAgeFlag
    ? Math.max(0, Number(maxAgeFlag.slice('--max-age-hours='.length)) * 3600 * 1000)
    : DEFAULT_MAX_AGE_MS

  const tempRoot = os.tmpdir()
  const entries = collect(tempRoot)
  const now = Date.now()
  let removed = 0
  let freed = 0
  let skipped = 0
  let failed = 0

  for (const entry of entries) {
    // 统一 --max-age-hours；卸载 Worker 目录额外加长到至少 24h，避免误伤进行中的卸载。
    const requiredAge = isWorkerDir(entry.name)
      ? Math.max(maxAgeMs, WORKER_MAX_AGE_MS)
      : maxAgeMs
    if (now - entry.mtimeMs < requiredAge) {
      skipped++
      continue
    }
    const size = entrySize(entry.target)
    if (removeEntry(entry.target, dryRun)) {
      removed++
      freed += size
      console.log(`[temp] ${dryRun ? 'would remove' : 'removed'} ${entry.name} (${(size / 1024).toFixed(1)} KiB)`)
    } else {
      failed++
      console.warn(`[temp] failed to remove ${entry.name}`)
    }
  }

  const gib = bytes => (bytes / 1024 ** 3).toFixed(2) + ' GiB'
  console.log(`[temp] ${dryRun ? 'dry-run: ' : ''}matched ${entries.length}, ${dryRun ? 'would free' : 'freed'} ${gib(freed)}, skipped recent ${skipped}, failed ${failed}`)
  // 单项删除失败不升级为构建阻断；只在完全无法读取 temp 时已有错误日志。
  if (failed > 0 && removed === 0 && !dryRun) process.exitCode = 1
}

module.exports = { PREFIXES, matches, collect, isWorkerDir }
if (require.main === module) main(process.argv.slice(2))
