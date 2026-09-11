// scripts/pack-portable.cjs
// 便携版打包后处理：将 win-unpacked 重命名为 SidekickAI 并压缩为 zip
// 用 7z 替代 PowerShell Compress-Archive（后者在大目录下偶发静默失败产出空 zip）

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const DIST_PORTABLE = path.join(ROOT, 'dist-portable')
const SRC_DIR = path.join(DIST_PORTABLE, 'win-unpacked')
const DST_DIR = path.join(DIST_PORTABLE, 'SidekickAI')

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
const VERSION = pkg.version
const ZIP_FILE = path.join(DIST_PORTABLE, `SidekickAI-Portable-${VERSION}-win-x64.zip`)

// 1. 检查 win-unpacked 是否存在
if (!fs.existsSync(SRC_DIR)) {
  console.error(`[pack-portable] 错误: ${SRC_DIR} 不存在`)
  console.error('  请确认 electron-builder --config electron-builder.portable.yml --win 已成功执行')
  process.exit(1)
}

// 2. 杀掉可能占用文件的 SidekickAI 进程
if (process.platform === 'win32') {
  spawnSync('taskkill', ['/IM', 'SidekickAI.exe', '/F'], { stdio: 'ignore', shell: true })
}

// 3. 删除旧的目标目录和 zip
if (fs.existsSync(DST_DIR)) {
  fs.rmSync(DST_DIR, { recursive: true, force: true })
}
if (fs.existsSync(ZIP_FILE)) {
  fs.rmSync(ZIP_FILE, { force: true })
}

// 4. 重命名 win-unpacked -> SidekickAI
fs.renameSync(SRC_DIR, DST_DIR)
console.log(`[pack-portable] ${path.basename(SRC_DIR)} -> ${path.basename(DST_DIR)}`)

// 5. 压缩
const SEVENZ = 'C:\\Program Files\\7-Zip\\7z.exe'

if (fs.existsSync(SEVENZ)) {
  // 优先用 7z（更快更可靠）
  console.log('[pack-portable] 使用 7z 压缩...')
  const r = spawnSync(SEVENZ, ['a', '-tzip', '-mx=5', ZIP_FILE, DST_DIR], {
    cwd: DIST_PORTABLE,
    stdio: 'inherit',
  })
  if (r.error || r.status !== 0) {
    console.error('[pack-portable] 7z 压缩失败，回退到 PowerShell Compress-Archive')
    compressWithPowerShell()
  } else {
    done()
  }
} else {
  compressWithPowerShell()
}

function compressWithPowerShell() {
  console.log('[pack-portable] 使用 PowerShell Compress-Archive 压缩...')
  const r = spawnSync('powershell', [
    '-NoProfile', '-Command',
    `Compress-Archive -Path '${DST_DIR}' -DestinationPath '${ZIP_FILE}' -Force`,
  ], { stdio: 'inherit', shell: true })

  if (r.error || r.status !== 0) {
    console.error('[pack-portable] PowerShell 压缩失败')
    process.exit(1)
  }
  done()
}

function done() {
  const sizeMB = (fs.statSync(ZIP_FILE).size / 1024 / 1024).toFixed(1)
  console.log(`[pack-portable] ✓ ${path.basename(ZIP_FILE)} (${sizeMB} MB)`)
}
