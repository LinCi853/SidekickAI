// scripts/dev.mjs — 跨平台 dev 启动器
//
// 替换原 package.json 中 Windows 专属的 "chcp 65001 && electron-vite dev"。
//   Windows: 先执行 chcp 65001 切换控制台到 UTF-8（保留原行为，避免中文日志乱码），
//            再启动 electron-vite dev
//   macOS/Linux: 设置 LANG/LC_ALL=en_US.UTF-8（控制台默认 UTF-8，环境变量为兜底），
//                启动 electron-vite dev
//
// 选用 node 脚本方案（任务"方案 B"）而非 cross-env（方案 A）：cross-env 只能设置环境变量，
// 无法执行 chcp 命令，会导致 Windows 中文控制台输出乱码，破坏现有 Windows 功能。

import { spawn, execSync } from 'node:child_process'

const isWin = process.platform === 'win32'

if (isWin) {
  // Windows：切换控制台代码页到 UTF-8（65001）
  try {
    execSync('chcp 65001', { stdio: 'inherit' })
  } catch (e) {
    console.warn('[dev] chcp 65001 失败，继续启动（控制台中文可能乱码）:', e.message)
  }
}

// macOS/Linux：设置 UTF-8 语言环境（兜底，多数发行版默认即 UTF-8）
const env = { ...process.env }
if (!isWin) {
  if (!env.LANG) env.LANG = 'en_US.UTF-8'
  if (!env.LC_ALL) env.LC_ALL = 'en_US.UTF-8'
}

// 启动 electron-vite dev，继承 stdio 以保留热更新输出与交互
// shell: Windows 上 electron-vite 是 .cmd，需要 shell 解析；
//        macOS/Linux 上为可执行脚本，直接 spawn 避免额外 sh 层
const child = spawn('electron-vite', ['dev'], {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
})

child.on('error', (err) => {
  console.error('[dev] 启动 electron-vite 失败:', err.message)
  console.error('[dev] 请确认已执行 npm install，且 node_modules/.bin/electron-vite 存在')
  process.exit(1)
})

child.on('exit', (code, signal) => {
  // 信号退出（如 Ctrl+C）按 0 处理，避免 npm 报错
  if (signal) {
    process.exit(0)
  }
  process.exit(code ?? 0)
})
