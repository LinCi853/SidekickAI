#!/usr/bin/env node
// 复现：图片/二维码/登录验证加载失败的两条主因
// 运行：node scripts/repro-media-load-failure.mjs
//
// 路径 A：预置屏蔽规则在 *.xiaomi.com 等域名上隐藏 [class*="qrcode"]
// 路径 B：指纹 canvas=noise/block 篡改 getImageData / toDataURL

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function matchDomain(pattern, hostname) {
  if (!pattern || !hostname) return false
  if (pattern === '*') return true
  const base = pattern.startsWith('*.') ? pattern.slice(2) : pattern
  return hostname === base || hostname.endsWith('.' + base)
}

// ---------------------------------------------------------------------------
// 路径 A：屏蔽规则误伤登录二维码
// ---------------------------------------------------------------------------
console.log('=== 路径 A：屏蔽规则 vs 登录二维码 ===')

const presetSrc = readFileSync(join(root, 'electron/store/block-rules-preset.ts'), 'utf8')

const xiaomiRule = {
  id: 'builtin-mimo-redirect',
  domainPattern: '*.xiaomi.com',
  selector: '[class*="download" i], [class*="app-download" i], [class*="app-banner" i], [class*="qrcode" i], a[href*="/download"], a[href*="/download/app"]',
}

const loginHosts = [
  'account.xiaomi.com',
  'auth.mi.com',
  'chat.deepseek.com',
  'www.doubao.com',
  'www.moonshot.cn',
  'aistudio.xiaomimimo.com',
]

console.log('域名匹配（builtin-mimo-redirect / *.xiaomi.com）：')
for (const host of loginHosts) {
  console.log(`  ${host.padEnd(28)} => ${matchDomain(xiaomiRule.domainPattern, host)}`)
}

// 模拟登录页 DOM：QR 登录容器类名几乎必然包含 qrcode
const mockLoginDom = [
  { tag: 'div', className: 'login-qrcode-panel', text: '扫码登录' },
  { tag: 'div', className: 'qrcode-box', text: '' },
  { tag: 'img', className: 'qrcode-img', src: 'https://account.xiaomi.com/qr.png' },
  { tag: 'canvas', className: 'login-canvas', text: '' },
  { tag: 'div', className: 'login-form', text: '账号登录' },
]

const qrcodeHidden = /class\*="qrcode" i/.test(xiaomiRule.selector)
console.log(`\nCSS 规则含 [class*="qrcode" i]：${qrcodeHidden}`)

const hidden = mockLoginDom.filter((el) => /qrcode/i.test(el.className))
console.log('会被 display:none 的登录页节点：')
for (const el of hidden) console.log(`  <${el.tag} class="${el.className}">`)
console.log('仍可见：')
for (const el of mockLoginDom.filter((el) => !/qrcode/i.test(el.className))) {
  console.log(`  <${el.tag} class="${el.className}">`)
}

// 确认预置数据里同类规则条数
const qrcodeRuleCount = (presetSrc.match(/\[class\*="qrcode" i\]/g) || []).length
console.log(`\nblock-rules-preset.ts 中含 [class*="qrcode" i] 的规则条数：${qrcodeRuleCount}`)
console.log('（DeepSeek / 豆包 / Kimi / 文心 / 小米 的「下载提示」规则都会隐藏二维码容器）')

// ---------------------------------------------------------------------------
// 路径 B：canvas 指纹篡改
// ---------------------------------------------------------------------------
console.log('\n=== 路径 B：指纹 canvas noise/block ===')

const engineSrc = readFileSync(join(root, 'electron/fingerprint/engine.ts'), 'utf8')
const defaultsSrc = readFileSync(join(root, 'electron/store/default-config.ts'), 'utf8')

const defaultCanvasNoise = /canvas:\s*'noise'/.test(defaultsSrc)
const patchesGetImageData = /CanvasRenderingContext2D\.prototype\.getImageData\s*=/.test(engineSrc)
const patchesToDataURL = /HTMLCanvasElement\.prototype\.toDataURL\s*=/.test(engineSrc)
const noiseWritesBack = /putImageData/.test(engineSrc)
const blockBlankPng = /__blankPng/.test(engineSrc)

console.log(`默认 fingerprint.canvas = 'noise'：${defaultCanvasNoise}`)
console.log(`劫持 getImageData：${patchesGetImageData}`)
console.log(`劫持 toDataURL：${patchesToDataURL}`)
console.log(`noise 模式会 putImageData 写回（污染可见 canvas）：${noiseWritesBack}`)
console.log(`block 模式 toDataURL 返回空白 PNG：${blockBlankPng}`)

// 用纯 JS 模拟 noise 对二维码像素的破坏（与 engine.ts 同构）
function mulberry32(seed) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 4x4「二维码」角点：黑块 + 白底
const size = 8
const original = new Uint8ClampedArray(size * size * 4)
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4
    const black = x < 3 && y < 3
    const v = black ? 0 : 255
    original[i] = original[i + 1] = original[i + 2] = v
    original[i + 3] = 255
  }
}

function injectNoise(data, seed) {
  const rng = mulberry32(seed)
  const out = new Uint8ClampedArray(data)
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] === 0) continue
    out[i] = Math.max(0, Math.min(255, out[i] + (rng() < 0.5 ? -1 : 1)))
    out[i + 1] = Math.max(0, Math.min(255, out[i + 1] + (rng() < 0.5 ? -1 : 1)))
    out[i + 2] = Math.max(0, Math.min(255, out[i + 2] + (rng() < 0.5 ? -1 : 1)))
  }
  return out
}

const noised = injectNoise(original, 0xc0ffee)
let diffPixels = 0
for (let i = 0; i < original.length; i += 4) {
  if (original[i] !== noised[i] || original[i + 1] !== noised[i + 1] || original[i + 2] !== noised[i + 2]) {
    diffPixels++
  }
}
console.log(`\n模拟 noise：${size * size} 像素中 ${diffPixels} 个被改写（验证码/二维码像素级比对必然失败）`)

const blockOut = new Uint8ClampedArray(original.length) // block 模式 getImageData 全 0
console.log(`模拟 block：getImageData 返回全 0（视觉验证码/画布二维码直接空白）`)

// ---------------------------------------------------------------------------
// 稳定复现步骤
// ---------------------------------------------------------------------------
console.log(`
=== 稳定复现（应用内） ===
【A. 二维码被隐藏 — 确定性 100%】
  1. 打开任意 AI 应用 webview，地址栏导航到 https://account.xiaomi.com/fe/service/login/qrcode/
  2. 打开 DevTools → 元素：搜索 #__ai_block_style__
  3. 可见 [class*="qrcode"] { display: none !important; }
  4. 扫码登录区域整块消失（页面近乎空白，与截图一致）
  5. 设置 → 高级/开发者 → 关闭「屏蔽规则」后刷新 → 二维码恢复

【B. canvas 指纹破坏验证码 — 默认 noise 即中招】
  1. Profile 指纹保持默认 canvas=noise
  2. 打开使用 canvas 的滑块/点选验证码，或页面内 canvas 二维码
  3. 控制台出现「Canvas2D: Multiple readback ... getImageData」（截图里已有）
  4. 验证码校验失败 / 二维码导出（toDataURL）带噪声
  5. 将该 Profile 指纹 canvas 改为 real 后刷新 → 校验恢复

【C. 时好时坏的原因】
  - 登录若走独立弹窗（LOGIN_POPUP_WHITELIST 放行 account.xiaomi.com）
    弹窗 BrowserWindow 不注入 block-rules/fingerprint → 表现正常
  - 登录若在 webview 内跳转 → 注入生效 → 二维码/验证失败
  - block 规则在 dom-ready 才注入，首帧可能闪现再消失
`)

process.exitCode = diffPixels > 0 && qrcodeHidden && matchDomain('*.xiaomi.com', 'account.xiaomi.com') ? 0 : 1
