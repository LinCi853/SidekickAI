import { app } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuntimeLog } from './runtime-log.js'

const levels: Record<string, number> = { error: 0, warn: 1, info: 2, log: 2, debug: 3 }
let threshold = 2
export function setRuntimeLogLevel(level: string): void { threshold = levels[level] ?? 2 }

export function runtimeLogDirectory(): string {
  if (process.env.SIDEKICK_DATA_DIR) return path.join(process.env.SIDEKICK_DATA_DIR, 'logs', 'runtime')
  return path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'SidekickAI', 'concept-logs')
}

export function initializeApplicationLog(): void {
  const log = createRuntimeLog(runtimeLogDirectory())
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level].bind(console)
    console[level] = (...values: unknown[]) => { if (levels[level] <= threshold) log.write(level, 'main', values); original(...values) }
  }
  log.write('info', 'lifecycle', ['Application starting', app.getVersion(), `pid=${process.pid}`])
  process.on('uncaughtExceptionMonitor', error => log.write('error', 'process', [error]))
  process.on('warning', warning => log.write('warn', 'process', [warning]))
  app.on('child-process-gone', (_event, details) => log.write('error', 'child-process', [details.type, details.reason, details.exitCode]))
  app.on('web-contents-created', (_event, contents) => {
    const local = () => {
      if (contents.getType() === 'webview') return false
      try {
        const url = new URL(contents.getURL())
        if (url.protocol === 'file:') return path.resolve(fileURLToPath(url)).toLowerCase() === path.resolve(app.getAppPath(), 'out/renderer/index.html').toLowerCase()
        return !!process.env.ELECTRON_RENDERER_URL && url.origin === new URL(process.env.ELECTRON_RENDERER_URL).origin
      } catch { return false }
    }
    contents.on('console-message', (_event, level, message) => {
      const severity = ['debug', 'info', 'warn', 'error'][level] ?? 'info'
      if (local() && levels[severity] <= threshold) log.write(severity, `renderer:${contents.id}`, [message])
    })
    contents.on('render-process-gone', (_event, details) => { if (local()) log.write('error', `renderer:${contents.id}`, [details.reason, details.exitCode]) })
  })
  app.on('will-quit', () => log.write('info', 'lifecycle', ['Application exiting', `loggingFailures=${log.failures}`]))
}
