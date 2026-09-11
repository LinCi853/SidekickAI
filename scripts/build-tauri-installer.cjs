// scripts/build-tauri-installer.cjs
// SidekickAI 安装向导（Tauri 2 + React + 7z solid 载荷）构建脚本
//
// 产物：单文件 SidekickAI-Setup-0.1.0-x64.exe
//   = 向导 exe + 追加的 payload.7z（双架构 solid 归档）+ 7zr.exe + 28B footer
//   向导启动时从自身尾部自解压出 payload.7z / 7zr.exe，再按宿主架构解压安装。
//
// 前置：主应用已构建出 dist/win-unpacked + dist/win-arm64-unpacked
//   （`npm run build:win-x64` 与 `npm run build:win-arm64`）
//
// 用法：node scripts/build-tauri-installer.cjs

const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const INSTALLER = path.join(ROOT, 'installer-tauri')
const SRC_TAURI = path.join(INSTALLER, 'src-tauri')
const NODE = process.execPath
const VITE_BIN = path.join(INSTALLER, 'node_modules', 'vite', 'bin', 'vite.js')
const TAURI_CLI = path.join(INSTALLER, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
const SEVENZ = 'C:\\Program Files\\7-Zip\\7z.exe'
const SEVENZ_R = path.join(ROOT, 'build', 'tools', '7zr.exe')
// 编译目标目录放到 C 盘用户目录，规避 E 盘 Windows Search 索引器锁文件导致的“拒绝访问”
const CARGO_TARGET_DIR = path.join(os.homedir(), '.cargo', 'sidekick-target')
const WIZARD_EXE = path.join(CARGO_TARGET_DIR, 'release', 'sidekickai-installer.exe')

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
const VERSION = pkg.version
const OUT_DIR = path.join(ROOT, 'release')
const OUT_EXE = path.join(OUT_DIR, `SidekickAI-Setup-${VERSION}-x64.exe`)

function run(cmd, args, label, opts = {}) {
  console.log(`\n[build] ${label}...`)
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    stdio: 'inherit',
    env: { ...process.env, CODEBUDDY_SAFE_DELETE_ENABLED: '0', ...(opts.env || {}) }
  })
  if (r.error) throw new Error(`${label} 启动失败: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`${label} 失败，退出码 ${r.status}`)
}

function mb(p) {
  return (fs.statSync(p).size / 1024 / 1024).toFixed(1)
}

// 1. 预检主应用双架构目录
function checkAppDirs() {
  const x64 = path.join(ROOT, 'dist', 'win-unpacked')
  const arm64 = path.join(ROOT, 'dist', 'win-arm64-unpacked')
  for (const [name, d] of [['x64', x64], ['arm64', arm64]]) {
    if (!fs.existsSync(d)) {
      console.error(`\n[build] ✗ 缺少 ${name} 应用目录: ${d}`)
      console.error(`  请先构建主应用双架构：npm run build:win-x64 与 build:win-arm64`)
      process.exit(1)
    }
  }
  if (!fs.existsSync(SEVENZ_R)) {
    console.error(`\n[build] ✗ 缺少 7zr.exe: ${SEVENZ_R}`)
    console.error(`  下载：curl -L -o build/tools/7zr.exe https://www.7-zip.org/a/7zr.exe`)
    process.exit(1)
  }
}

// 2. 前端构建（先生成 latest 清单 json → tsc 类型检查 + vite 打包）
function buildFrontend() {
  run(NODE, [path.join(ROOT, 'scripts', 'gen-install-manifest.cjs')], '清单生成 (install-manifest.json)', {
    cwd: ROOT
  })
  if (!fs.existsSync(VITE_BIN)) {
    throw new Error(`找不到 vite 二进制: ${VITE_BIN}，请先 cd installer-tauri && npm install`)
  }
  // 显式设置 TAURI_ENV_PLATFORM=windows → vite base 用相对路径 './'，
  // 否则 Tauri (tauri://localhost) 下 /assets/ 绝对路径资源加载不到，白屏/无法访问
  run(NODE, [VITE_BIN, 'build'], '前端构建 (vite)', { cwd: INSTALLER, env: { TAURI_ENV_PLATFORM: 'windows' } })
}

// 3. Rust 后端构建
function buildRust() {
  if (!fs.existsSync(TAURI_CLI)) {
    throw new Error(`找不到 Tauri CLI: ${TAURI_CLI}，请先 cd installer-tauri && npm install`)
  }
  // 必须通过 tauri build 生成上下文并嵌入 frontendDist；直接 cargo build
  // 会读取 devUrl，最终 exe 启动时会访问 localhost:1420。
  run(NODE, [TAURI_CLI, 'build', '--no-bundle', '--', '--offline', '--jobs', '2'], '生产向导构建 (tauri build)', {
    cwd: SRC_TAURI,
    env: { CARGO_TARGET_DIR }
  })
  if (!fs.existsSync(WIZARD_EXE)) {
    throw new Error(`未找到向导 exe: ${WIZARD_EXE}`)
  }
  console.log(`[build] ✓ 向导 exe: ${WIZARD_EXE} (${mb(WIZARD_EXE)} MB)`)
}

// 4. 生成双架构 solid 载荷（若已存在且更新于应用目录则复用）
function buildPayload() {
  const payload = path.join(INSTALLER, 'payload.7z')
  const newestApp = Math.max(
    fs.statSync(path.join(ROOT, 'dist', 'win-unpacked')).mtimeMs,
    fs.statSync(path.join(ROOT, 'dist', 'win-arm64-unpacked')).mtimeMs
  )
  if (fs.existsSync(payload) && fs.statSync(payload).mtimeMs > newestApp) {
    console.log(`[build] ✓ 复用已有载荷: ${mb(payload)} MB`)
    return payload
  }
  // 重新生成前必须先删除旧归档：7z 的 `a` 是「增量更新」语义，
  // 直接 add 到既有归档会保留上一版有、本版已删除的文件（ghost 残留），
  // 导致安装器释放出旧版 DLL / 旧原生模块等不该存在的文件。
  if (fs.existsSync(payload)) {
    fs.rmSync(payload, { force: true })
    console.log('[build] 已删除旧载荷，重新生成（避免增量残留）')
  }
  run(
    SEVENZ,
    ['a', '-t7z', '-mx=9', '-md=256m', '-ms=on', '-y', payload, 'win-unpacked', 'win-arm64-unpacked'],
    '生成 solid 载荷 (7z)',
    { cwd: path.join(ROOT, 'dist') }
  )
  console.log(`[build] ✓ payload.7z: ${mb(payload)} MB`)
  return payload
}

// 5. 追加 payload.7z + 7zr.exe + footer → 单文件
function appendSelfExtract(payload) {
  const wizard = fs.readFileSync(WIZARD_EXE)
  const p = fs.readFileSync(payload)
  const s = fs.readFileSync(SEVENZ_R)
  const footer = Buffer.alloc(28)
  footer.write('SKPAYLD1', 0, 'ascii')
  footer.writeBigUInt64LE(BigInt(p.length), 8)
  footer.writeBigUInt64LE(BigInt(s.length), 16)
  footer.writeUInt32LE(28, 24)
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const out = Buffer.concat([wizard, p, s, footer])
  fs.writeFileSync(OUT_EXE, out)
  console.log(`[build] ✓ 单文件安装器: ${OUT_EXE} (${mb(OUT_EXE)} MB)`)
}

function main() {
  console.log('=========================================')
  console.log('  SidekickAI 安装向导构建（Tauri + 7z）')
  console.log(`  版本: ${VERSION}`)
  console.log('=========================================')
  checkAppDirs()
  buildFrontend()
  buildRust()
  const payload = buildPayload()
  appendSelfExtract(payload)
  console.log('\n=========================================')
  console.log(`  构建完成 → ${OUT_EXE}`)
  console.log('=========================================')
}

try {
  main()
} catch (err) {
  console.error('\n[build] 失败:', err.message)
  process.exit(1)
}
