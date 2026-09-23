// Archive the standalone runtime and verify its portable entry points.
// Retry temporary filesystem locks without terminating application processes.

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const DIST_PORTABLE = path.join(ROOT, 'dist-portable')
const SRC_DIR = path.join(DIST_PORTABLE, 'win-unpacked')
const DST_DIR = path.join(DIST_PORTABLE, 'SidekickAI-OpenSource')
const DIR_NAME = path.basename(DST_DIR)

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
const VERSION = pkg.version
const ZIP_NAME = `SidekickAI-OpenSource-Portable-${VERSION}-win-x64.zip`
const ZIP_FILE = path.join(DIST_PORTABLE, ZIP_NAME)

// zip 体积下限（MB）。带完整 Electron 运行时的便携包不可能低于此值，
// 低于它基本可判定为空包 / 半包。
const MIN_ZIP_MB = 60

/** 同步等待（本脚本为纯同步流程） */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 重试执行。仅对「文件被临时占用」类错误重试，
 * 其它错误（磁盘满、路径不存在等）立即抛出，避免掩盖真问题。
 */
function withRetry(label, fn, attempts = 5, delayMs = 1500) {
  const retriable = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE'])
  let lastErr
  for (let i = 1; i <= attempts; i++) {
    try {
      return fn()
    } catch (err) {
      lastErr = err
      if (!retriable.has(err.code) || i === attempts) break
      console.warn(
        `[pack-portable] ${label} 被占用(${err.code})，${delayMs}ms 后重试 (${i}/${attempts - 1})`
      )
      sleepSync(delayMs)
    }
  }
  throw lastErr
}

/**
 * 读取 zip 中央目录，返回条目名列表（无需第三方依赖）。
 * 用于校验产物，替代"只看文件大小"的盲信。
 */
function listZipEntries(zipPath) {
  const st = fs.statSync(zipPath)
  const fd = fs.openSync(zipPath, 'r')
  try {
    // 1) 从尾部找 EOCD（可能带注释，最多 64KB + 22）
    const tailLen = Math.min(st.size, 65536 + 22)
    const tail = Buffer.alloc(tailLen)
    fs.readSync(fd, tail, 0, tailLen, st.size - tailLen)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i
        break
      }
    }
    if (eocd < 0) return null

    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOff = tail.readUInt32LE(eocd + 16)
    if (!cdSize || cdOff === 0xffffffff) return null // zip64 不支持，交给体积校验兜底

    // 2) 读中央目录
    const cd = Buffer.alloc(cdSize)
    fs.readSync(fd, cd, 0, cdSize, cdOff)
    const names = []
    let p = 0
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const cmtLen = cd.readUInt16LE(p + 32)
      names.push(cd.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/'))
      p += 46 + nameLen + extraLen + cmtLen
    }
    return names
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 校验 zip：体积合理 + 必须含入口 exe、app.asar 与 portable.txt，
 * 避免历史上出现过的「空 zip 却报成功」。
 */
function verifyZip(zipPath) {
  if (!fs.existsSync(zipPath)) {
    console.error(`[pack-portable] ✗ 未生成 zip: ${zipPath}`)
    process.exit(1)
  }
  const sizeMB = fs.statSync(zipPath).size / 1024 / 1024
  const entries = listZipEntries(zipPath)

  if (entries) {
    const hasExe = entries.includes(`${DIR_NAME}/SidekickAI-OpenSource.exe`)
    const hasAsar = entries.includes(`${DIR_NAME}/resources/app.asar`)
    const hasFlag = entries.includes(`${DIR_NAME}/portable.txt`)
    if (!hasExe || !hasAsar || !hasFlag) {
      console.error('[pack-portable] ✗ zip 结构异常，疑似空包 / 半包：')
      console.error(`    条目总数       : ${entries.length}`)
      console.error(`    入口 exe       : ${hasExe ? '有' : '缺失'}`)
      console.error(`    resources/asar : ${hasAsar ? '有' : '缺失'}`)
      console.error(`    portable.txt   : ${hasFlag ? '有' : '缺失'}`)
      console.error(`    前 10 条       : ${entries.slice(0, 10).join(', ')}`)
      process.exit(1)
    }
    if (sizeMB < MIN_ZIP_MB) {
      console.error(
        `[pack-portable] ✗ zip 体积异常偏小: ${sizeMB.toFixed(1)} MB（下限 ${MIN_ZIP_MB} MB）`
      )
      process.exit(1)
    }
    console.log(`[pack-portable] ✓ 校验通过（${entries.length} 个条目，${sizeMB.toFixed(1)} MB）`)
    return
  }

  console.warn('[pack-portable] ⚠ 无法解析 zip 目录（可能为 zip64），仅做体积校验')
  if (sizeMB < MIN_ZIP_MB) {
    console.error(
      `[pack-portable] ✗ zip 体积异常偏小: ${sizeMB.toFixed(1)} MB（下限 ${MIN_ZIP_MB} MB）`
    )
    process.exit(1)
  }
  console.log(`[pack-portable] ✓ ${ZIP_NAME} (${sizeMB.toFixed(1)} MB)`)
}

// ── 主流程 ──

// 1. 检查 electron-builder 产物
if (!fs.existsSync(SRC_DIR)) {
  console.error(`[pack-portable] 错误: ${SRC_DIR} 不存在`)
  console.error('  请确认 electron-builder --config electron-builder.portable.yml --win 已成功执行')
  process.exit(1)
}

// Existing packages may contain user data or retained release evidence.
if (fs.existsSync(DST_DIR) || fs.existsSync(ZIP_FILE)) {
  console.error('[pack-portable] Output already exists; archive it before packaging again.')
  process.exit(1)
}

// Retain the unpacked runtime under the edition's distribution name.
withRetry('重命名 win-unpacked', () => fs.renameSync(SRC_DIR, DST_DIR))
console.log(`[pack-portable] ${path.basename(SRC_DIR)} -> ${DIR_NAME}`)

// Relative inputs keep the distribution directory as the archive root.
const SEVENZ = 'C:\\Program Files\\7-Zip\\7z.exe'
let packed = false

if (fs.existsSync(SEVENZ)) {
  console.log('[pack-portable] 使用 7z 压缩...')
  const r = spawnSync(SEVENZ, ['a', '-tzip', '-mx=5', '-y', ZIP_NAME, DIR_NAME], {
    cwd: DIST_PORTABLE,
    stdio: 'inherit',
  })
  if (r.error || r.status !== 0) {
    console.error('[pack-portable] 7z 压缩失败，回退到 PowerShell Compress-Archive')
    if (fs.existsSync(ZIP_FILE)) fs.rmSync(ZIP_FILE, { force: true })
  } else {
    packed = true
  }
}

if (!packed) {
  console.log('[pack-portable] 使用 PowerShell Compress-Archive 压缩...')
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${DST_DIR}' -DestinationPath '${ZIP_FILE}' -Force`,
    ],
    { stdio: 'inherit', shell: true }
  )
  if (r.error || r.status !== 0) {
    console.error('[pack-portable] PowerShell 压缩失败')
    process.exit(1)
  }
}

// 6. 校验产物结构 —— 不校验的话，空包会以「成功」返回
verifyZip(ZIP_FILE)
