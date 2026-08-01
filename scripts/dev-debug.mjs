import { spawn, execSync } from 'node:child_process'

const isWin = process.platform === 'win32'

if (isWin) {
  try {
    execSync('chcp 65001', { stdio: 'inherit' })
  } catch (e) {
    console.warn('[dev-debug] chcp 65001 失败:', e.message)
  }
}

const env = { ...process.env }
if (!isWin) {
  if (!env.LANG) env.LANG = 'en_US.UTF-8'
  if (!env.LC_ALL) env.LC_ALL = 'en_US.UTF-8'
}

const child = spawn('npx', ['electron-vite', 'dev', '--', '--remote-debugging-port=9223'], {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
})

child.on('error', (err) => {
  console.error('[dev-debug] 启动失败:', err.message)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(0)
  }
  process.exit(code ?? 0)
})
