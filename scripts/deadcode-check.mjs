// scripts/deadcode-check.mjs — 死代码 ratchet 门禁（包装 knip）
//
// knip 报告当前死代码（未使用文件/依赖/导出/类型/重复导出/未解析导入）。
// 本包装将其与 scripts/deadcode-baseline.json 对照：
//   - 基线之外的"新增"死代码 → 违规，退出码 1（只减不增）
//   - 基线中已不存在的条目 → 提示用 --prune 收紧基线
//   - --prune：用当前报告重写基线（先人工确认清理完成）
//
// 行号/列号不入基线（随编辑漂移），按 file + name + kind 识别条目。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baselineFile = path.join(root, 'scripts/deadcode-baseline.json')

export const emptyBaseline = () => ({
  schemaVersion: 1,
  files: [],
  dependencies: [],
  devDependencies: [],
  unlisted: [],
  unresolved: [],
  exports: [],
  types: [],
  duplicates: [],
})

const CATEGORY_VALUE_KEYS = [
  'dependencies',
  'devDependencies',
  'unlisted',
  'unresolved',
  'exports',
  'types',
]
const ARRAY_VALUE_KEYS = ['files', ...CATEGORY_VALUE_KEYS, 'duplicates']

/** 把 knip issues 数组展开成与基线同构的逐类条目集合（忽略行号）。 */
export function flattenIssues(issues) {
  const flat = emptyBaseline()
  for (const issue of issues) {
    const file = issue.file
    for (const key of CATEGORY_VALUE_KEYS) {
      for (const item of issue[key] ?? []) {
        flat[key].push({ file, name: item.name })
      }
    }
    for (const item of issue.files ?? []) flat.files.push({ file: item.name ?? item })
    for (const pair of issue.duplicates ?? []) {
      const names = pair
        .map((exported) => exported.name)
        .sort()
        .join('|')
      flat.duplicates.push({ file, name: names })
    }
  }
  for (const key of ARRAY_VALUE_KEYS) flat[key].sort(compareItems)
  return flat
}

function compareItems(a, b) {
  return a.file === b.file ? a.name.localeCompare(b.name) : a.file.localeCompare(b.file)
}

const itemKey = (item) => `${item.file}|${item.name}`

/** 返回 current 中 baseline 没有覆盖的条目（新增违规）。 */
export function diffAgainstBaseline(current, baseline) {
  const result = emptyBaseline()
  for (const key of ARRAY_VALUE_KEYS) {
    const allowed = new Set((baseline[key] ?? []).map(itemKey))
    result[key] = current[key].filter((item) => !allowed.has(itemKey(item)))
  }
  return result
}

/** 返回基线中已经不存在于 current 的条目（提示收紧）。 */
export function findStaleBaseline(current, baseline) {
  const result = emptyBaseline()
  for (const key of ARRAY_VALUE_KEYS) {
    const present = new Set(current[key].map(itemKey))
    result[key] = (baseline[key] ?? []).filter((item) => !present.has(itemKey(item)))
  }
  return result
}

export function countItems(flat) {
  return ARRAY_VALUE_KEYS.reduce((sum, key) => sum + flat[key].length, 0)
}

function runKnip() {
  const bin = path.join(root, 'node_modules/knip/bin/knip.js')
  let stdout
  try {
    // knip 发现问题时退出码为 1，但 JSON 报告仍完整输出到 stdout
    execFileSync(process.execPath, [bin, '--reporter', 'json'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    throw new Error('knip exited 0 without reporting issues')
  } catch (error) {
    stdout = error.stdout
    if (!stdout) throw error
  }
  const report = JSON.parse(stdout)
  return flattenIssues(report.issues ?? [])
}

const LABELS = {
  files: '未使用文件',
  dependencies: '未使用依赖',
  devDependencies: '未使用开发依赖',
  unlisted: '未声明依赖',
  unresolved: '未解析导入',
  exports: '未使用导出',
  types: '未使用类型导出',
  duplicates: '重复导出',
}

async function main() {
  const current = runKnip()
  if (process.argv.includes('--prune')) {
    const baseline = { ...emptyBaseline() }
    for (const key of ARRAY_VALUE_KEYS) baseline[key] = current[key]
    fs.writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`)
    console.log(`Deadcode baseline written: ${countItems(current)} entries`)
    return
  }
  if (!fs.existsSync(baselineFile)) {
    console.error('Missing scripts/deadcode-baseline.json — run deadcode:check --prune once.')
    process.exitCode = 1
    return
  }
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'))
  const newIssues = diffAgainstBaseline(current, baseline)
  const stale = findStaleBaseline(current, baseline)
  let violations = 0
  for (const key of ARRAY_VALUE_KEYS) {
    for (const item of newIssues[key]) {
      violations += 1
      console.error(`New dead code (${LABELS[key]}): ${item.file} :: ${item.name}`)
    }
  }
  let staleCount = 0
  for (const key of ARRAY_VALUE_KEYS) {
    staleCount += stale[key].length
  }
  if (staleCount > 0) {
    console.log(
      `Baseline holds ${staleCount} resolved entries; run "deadcode:check --prune" to tighten it.`,
    )
  }
  if (violations > 0) {
    console.error(
      `Deadcode gate: ${violations} new entries. Remove the code or extend deadcode-baseline.json deliberately.`,
    )
    process.exitCode = 1
    return
  }
  console.log(`Deadcode gate: clean (${countItems(current)} baselined entries).`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
