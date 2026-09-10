// scripts/gen-install-manifest.cjs — 从主应用单一数据源生成安装向导清单
//
// 执行：打包 electron/shared/install-manifest-source.ts（esbuild，纯数据无副作用），
// 将其 INSTALL_MANIFEST 序列化为 installer-tauri/src-tauri/install-manifest.json，
// 安装向导（Rust include_str! / 前端）统一从此读取。
//
// 触发：installer-tauri 的 prebuild / predev，以及 install-manifest-source.ts
// 依赖的主应用侧文件变更后手动执行：node scripts/gen-install-manifest.cjs

const path = require('path')
const fs = require('fs')
const esbuild = require('esbuild')

const ROOT = path.resolve(__dirname, '..')
const ENTRY = path.join(ROOT, 'electron', 'shared', 'install-manifest-source.ts')
const TMP_BUNDLE = path.join(ROOT, 'build', '.install-manifest-source.cjs')
const OUT = path.join(ROOT, 'installer-tauri', 'src-tauri', 'install-manifest.json')

function fail(msg) {
  console.error('[gen-install-manifest] ERROR:', msg)
  process.exit(1)
}

if (!fs.existsSync(ENTRY)) fail(`清单源不存在: ${ENTRY}`)

// 仅打包纯数据入口，不加载任何副作用模块（wiring/store 原生依赖均不进入）
esbuild.buildSync({
  entryPoints: [ENTRY],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: TMP_BUNDLE,
  logLevel: 'silent',
})

let payload
try {
  payload = require(TMP_BUNDLE).INSTALL_MANIFEST
} catch (err) {
  fail(`加载清单源失败: ${err && err.message}`)
}

if (!Array.isArray(payload.features) || !Array.isArray(payload.options)) {
  fail('清单源缺少 features/options 数组')
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf-8')
// 临时产物保持放在 build/（clean:build 之外的目录），不混入源码
fs.rmSync(TMP_BUNDLE, { force: true })

console.log(
  `[gen-install-manifest] 已生成 ${path.relative(ROOT, OUT)}  ` +
    `(features=${payload.features.length}, options=${payload.options.length})`
)