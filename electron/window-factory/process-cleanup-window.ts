// electron/window-factory/process-cleanup-window.ts — 便携版残留进程清理窗口
//
// 便携版启动时若检测到系统中存在其他 SidekickAI.exe 残留进程（如上次崩溃未退出），
// 弹出此独立小窗口提示用户"一键清理"或"忽略并继续"。
//
// 设计要点：
//   - 使用 data: URL 自包含 HTML，无需新增 React 路由 / IPC 通道 / preload 暴露
//   - 按钮点击通过 console.log('__CLEANUP_ACTION__:xxx') 通信，主进程监听 console-message 事件
//   - 返回 Promise<'clean' | 'ignore'>，由调用方决定后续行为
//   - 单例：同时仅显示一个清理窗口（防止重复弹出）

import { BrowserWindow, screen } from 'electron'
import { WINDOW_BACKGROUND_COLOR, createDefaultWebPreferences } from './helpers.js'
import { buildWindowConfig } from './window-config-builder.js'
import type { ProcessInfo } from '../utils/process-guard.js'

/** 通信协议：按钮点击时 renderer 通过 console.log 输出此前缀 + action */
const CLEANUP_ACTION_LOG_PREFIX = '__CLEANUP_ACTION__:'

/** 当前清理窗口实例（单例） */
let cleanupWindow: BrowserWindow | null = null

/**
 * 构建清理窗口的 HTML 内容（自包含，无外部依赖）。
 * 暗色主题匹配应用主背景色，按钮点击通过 console.log 通信。
 */
function buildCleanupHtml(processes: ProcessInfo[]): string {
  const processListHtml = processes
    .map(
      (p, i) =>
        `<tr><td>${i + 1}</td><td>${p.pid}</td><td>${
          p.memUsage ? (p.memUsage / 1024).toFixed(1) + ' MB' : '—'
        }</td></tr>`,
    )
    .join('')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>残留进程清理</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 100%; height: 100%;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: ${WINDOW_BACKGROUND_COLOR};
    color: #f5f5f5;
    overflow: hidden;
    user-select: none;
    -webkit-user-select: none;
  }
  .container {
    display: flex; flex-direction: column;
    width: 100%; height: 100%;
    padding: 24px;
    gap: 16px;
  }
  .header {
    display: flex; align-items: center; gap: 12px;
  }
  .icon {
    width: 36px; height: 36px;
    border-radius: 8px;
    background: linear-gradient(135deg, #f97316, #ea580c);
    display: flex; align-items: center; justify-content: center;
    font-size: 20px; font-weight: 800;
    color: #fff;
    flex-shrink: 0;
  }
  .title { font-size: 16px; font-weight: 700; }
  .subtitle { font-size: 13px; color: #a1a1aa; margin-top: 2px; }
  .process-list {
    flex: 1;
    overflow-y: auto;
    border: 1px solid #3f3f46;
    border-radius: 8px;
    padding: 12px;
    background: rgba(0, 0, 0, 0.2);
  }
  .process-list table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    font-family: ui-monospace, "Cascadia Code", monospace;
  }
  .process-list th, .process-list td {
    text-align: left;
    padding: 6px 8px;
    border-bottom: 1px solid #27272a;
  }
  .process-list th {
    color: #a1a1aa;
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
  }
  .process-list tr:last-child td { border-bottom: none; }
  .actions {
    display: flex; gap: 12px;
    justify-content: flex-end;
  }
  button {
    padding: 8px 20px;
    border: none;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s;
    font-family: inherit;
  }
  button:active { opacity: 0.85; }
  .btn-clean {
    background: #f97316;
    color: #fff;
  }
  .btn-clean:hover { background: #ea580c; }
  .btn-ignore {
    background: transparent;
    color: #d4d4d8;
    border: 1px solid #52525b;
  }
  .btn-ignore:hover { background: rgba(255, 255, 255, 0.05); }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="icon">!</div>
    <div>
      <div class="title">检测到 ${processes.length} 个残留 SidekickAI 进程</div>
      <div class="subtitle">可能是上次异常退出残留，建议清理后继续启动以避免冲突</div>
    </div>
  </div>
  <div class="process-list">
    <table>
      <thead>
        <tr><th>#</th><th>PID</th><th>内存占用</th></tr>
      </thead>
      <tbody>
        ${processListHtml}
      </tbody>
    </table>
  </div>
  <div class="actions">
    <button class="btn-ignore" id="btn-ignore">忽略并继续</button>
    <button class="btn-clean" id="btn-clean">一键清理</button>
  </div>
</div>
<script>
  (function() {
    var prefix = ${JSON.stringify(CLEANUP_ACTION_LOG_PREFIX)};
    document.getElementById('btn-clean').addEventListener('click', function() {
      console.log(prefix + 'clean');
    });
    document.getElementById('btn-ignore').addEventListener('click', function() {
      console.log(prefix + 'ignore');
    });
  })();
</script>
</body>
</html>`
}

/**
 * 显示残留进程清理窗口（单例）。
 *
 * @param processes 检测到的残留进程列表（非空）
 * @returns 用户选择：'clean'（一键清理）或 'ignore'（忽略并继续）
 */
export function showProcessCleanupWindow(processes: ProcessInfo[]): Promise<'clean' | 'ignore'> {
  return new Promise((resolve) => {
    // 单例：若已有清理窗口，聚焦并返回已有的 promise（通过闭包缓存）
    if (cleanupWindow && !cleanupWindow.isDestroyed()) {
      if (cleanupWindow.isMinimized()) cleanupWindow.restore()
      if (!cleanupWindow.isVisible()) cleanupWindow.show()
      cleanupWindow.focus()
      // 已有窗口的 promise 不会被外部捕获，这里直接 resolve 'ignore'（不应发生）
      resolve('ignore')
      return
    }

    const workArea = screen.getPrimaryDisplay().workArea
    const width = 480
    const height = 360
    const x = workArea.x + Math.round((workArea.width - width) / 2)
    const y = workArea.y + Math.round((workArea.height - height) / 2)

    const win = new BrowserWindow(
      buildWindowConfig({
        width,
        height,
        x,
        y,
        minWidth: 400,
        minHeight: 300,
        show: false,
        frame: false,
        resizable: true,
        maximizable: false,
        fullscreenable: false,
        minimizable: false,
        backgroundColor: WINDOW_BACKGROUND_COLOR,
        title: '残留进程清理',
        alwaysOnTop: true,
        webPreferences: {
          ...createDefaultWebPreferences({
            preload: '',
            webviewTag: false,
          }),
          // 不使用 preload：自包含 HTML 通过 console-message 通信
          preload: undefined,
          sandbox: true,
        },
      }),
    )
    cleanupWindow = win

    // 加载自包含 HTML（data: URL）
    const html = buildCleanupHtml(processes)
    void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))

    win.once('ready-to-show', () => {
      win.show()
      win.focus()
    })

    // 监听 renderer 的 console.log，捕获按钮点击动作
    let resolved = false
    const onConsoleMessage = (_e: Electron.Event, _level: number, message: string) => {
      if (typeof message !== 'string') return
      if (!message.startsWith(CLEANUP_ACTION_LOG_PREFIX)) return
      const action = message.slice(CLEANUP_ACTION_LOG_PREFIX.length).trim()
      if (action !== 'clean' && action !== 'ignore') return
      if (resolved) return
      resolved = true
      // 关闭窗口后 resolve（closed 事件触发后 cleanupWindow 被清空）
      win.close()
      resolve(action)
    }
    win.webContents.on('console-message', onConsoleMessage)

    // 用户直接关闭窗口（如按 ESC 或系统关闭按钮）→ 视为"忽略并继续"
    win.on('closed', () => {
      cleanupWindow = null
      if (!resolved) {
        resolved = true
        resolve('ignore')
      }
    })
  })
}
