// electron/utils/safe-zip.ts — 安全的 zip 解压（防路径穿越 / 符号链接覆盖）
//
// 为什么需要这层：
//   adm-zip 存在已知安全问题（GHSA-xcpc-8h2w-3j85 构造 zip 触发 4GB 内存分配；
//   GHSA-vwc7-r8mq-g2x9 解压时跟随目标端符号链接，可覆盖任意文件），
//   其中符号链接问题在最新版（0.6.0）仍未修复、上游没有补丁版本。
//   因此所有对**不可信 zip**（用户导入的备份、下载的模型包）的解压都必须走这里，
//   在写入前自行校验条目名与目标路径，而不是依赖库的行为。
//
// 防护点：
//   1. 条目名：拒绝绝对路径、盘符、.. 穿越、控制字符/NUL
//   2. 目标路径：解析后必须落在 destDir 之内（防止解析差异绕过）
//   3. 符号链接：目标或其任一父目录是符号链接则拒绝（防写穿到 destDir 外）
//   4. 符号链接条目：zip 内携带的 symlink 条目直接跳过，不落盘
//   5. 规模上限：条目数与单条解压后大小设上限，防 zip bomb

import * as fs from 'fs'
import * as path from 'path'
import AdmZip from 'adm-zip'

/** 单个 zip 允许的条目数上限 */
const MAX_ENTRIES = 20_000
/** 单个条目解压后大小上限（512MB） */
const MAX_ENTRY_SIZE = 512 * 1024 * 1024
/** zip 内 symlink 条目的外部属性标志位（(attr >>> 16) & S_IFMT === S_IFLNK） */
const S_IFMT = 0xf000
const S_IFLNK = 0xa000

/**
 * 判断 zip 条目名是否安全。
 * 统一把反斜杠视为分隔符（Windows 生成的 zip 常见），再做校验。
 *
 * @param entryName zip 内的条目名
 * @returns 安全返回 true；绝对路径 / 盘符 / .. 穿越 / 控制字符返回 false
 */
export function isSafeEntryName(entryName: string): boolean {
  if (!entryName || typeof entryName !== 'string') return false
  // NUL 与不可见控制字符
  if (/[\u0000-\u001f\u007f]/.test(entryName)) return false
  const normalized = entryName.replace(/\\/g, '/')
  // 绝对路径（/ 或 //）或 Windows 盘符（C:/、\\server\share）
  if (normalized.startsWith('/')) return false
  if (/^[A-Za-z]:/.test(entryName)) return false
  if (entryName.startsWith('\\\\')) return false
  // 路径穿越
  const segments = normalized.split('/')
  if (segments.some((s) => s === '..')) return false
  return true
}

/** 该条目是否为 zip 内携带的符号链接（尽力而为：依赖 external attributes） */
function isSymlinkEntry(entry: AdmZip.IZipEntry): boolean {
  // adm-zip 的类型定义未暴露 header.attr，按需做安全访问
  const attr = (entry as unknown as { header?: { attr?: number } })?.header?.attr
  if (typeof attr !== 'number') return false
  return ((attr >>> 16) & S_IFMT) === S_IFLNK
}

/**
 * 解析条目的落盘路径，并确认它安全地位于 destDir 之内。
 *
 * @param destDir 解压根目录（必须已存在）
 * @param entryName 已通过 isSafeEntryName 校验的条目名
 * @param flatten true=只取文件名平铺到 destDir（与 PowerShell 解压的产出结构一致）
 * @returns 合法的绝对路径；不安全返回 null
 */
export function resolveSafeTarget(
  destDir: string,
  entryName: string,
  flatten = false,
): string | null {
  const normalized = entryName.replace(/\\/g, '/')
  const relative = flatten ? path.basename(normalized) : normalized
  if (!relative || relative === '.' || relative === '..') return null

  const root = path.resolve(destDir)
  const target = path.resolve(root, relative)
  // 必须落在 root 之内（含 root 本身）
  if (target !== root && !target.startsWith(root + path.sep)) return null

  // 目标本身是符号链接 → 拒绝（否则会写穿到别处）
  try {
    const st = fs.lstatSync(target)
    // eslint-disable-next-line no-bitwise
    if (st.isSymbolicLink()) return null
  } catch {
    // 不存在 = 正常情况
  }

  // 任一父目录是符号链接 → 拒绝
  let cursor = path.dirname(target)
  while (cursor.length >= root.length) {
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) return null
    } catch {
      // 不存在则继续向上
    }
    if (cursor === root) break
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return target
}

export interface SafeExtractOptions {
  /** 平铺到 destDir 根目录，去掉 zip 内部子目录层级 */
  flatten?: boolean
  /** 日志前缀，默认 [safe-zip] */
  tag?: string
}

/**
 * 安全地把整个 zip 解压到 destDir。
 * 任何不安全条目都会被跳过并记录，不抛异常（避免单个恶意条目中断整体流程）。
 *
 * @param zip 已打开的 AdmZip 实例
 * @param destDir 目标目录（不存在时自动创建）
 * @param options flatten / tag
 * @returns 实际解压的文件数
 */
export function safeExtractAll(
  zip: AdmZip,
  destDir: string,
  options: SafeExtractOptions = {},
): number {
  const { flatten = false, tag = '[safe-zip]' } = options
  const entries = zip.getEntries()
  if (entries.length === 0) return 0
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`${tag} zip 条目数异常（${entries.length}），已中止`)
  }

  fs.mkdirSync(destDir, { recursive: true })

  let written = 0
  for (const entry of entries) {
    if (entry.isDirectory) continue
    if (!isSafeEntryName(entry.entryName)) {
      console.warn(`${tag} 跳过不安全条目名: ${entry.entryName}`)
      continue
    }
    if (isSymlinkEntry(entry)) {
      console.warn(`${tag} 跳过符号链接条目: ${entry.entryName}`)
      continue
    }
    if (typeof entry.header?.size === 'number' && entry.header.size > MAX_ENTRY_SIZE) {
      console.warn(`${tag} 跳过超大条目: ${entry.entryName} (${entry.header.size} bytes)`)
      continue
    }
    const target = resolveSafeTarget(destDir, entry.entryName, flatten)
    if (!target) {
      console.warn(`${tag} 跳过越界/符号链接目标: ${entry.entryName}`)
      continue
    }
    // maintainEntryPath 与 flatten 相反；overwrite=true 保证同名覆盖不残留旧版本
    zip.extractEntryTo(entry, destDir, !flatten, true)
    written += 1
  }
  return written
}
