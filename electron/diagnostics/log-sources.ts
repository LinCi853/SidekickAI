import { app } from 'electron'
import path from 'node:path'
import { runtimeLogDirectory } from './application-log.js'
import type { LogSource } from '../store/activity-log-export.js'

export function applicationLogSources(): LogSource[] {
  const local = process.env.LOCALAPPDATA || app.getPath('appData')
  const temporary = app.getPath('temp')
  return [
    { id: 'runtime', directory: runtimeLogDirectory(), dated: true },
    { id: 'electron', directory: app.getPath('logs') },
    { id: 'activity-legacy', directory: path.join(app.getPath('userData'), 'logs'), file: 'activity-records.json' },
    { id: 'maintenance', directory: path.join(local, 'SidekickAI', 'installer-logs') },
    { id: 'installer-operations', directory: path.join(temporary, 'SidekickAI-Installer'), operationDirectories: true },
    { id: 'installer-legacy', directory: temporary, file: 'SidekickAI-install.log' },
  ]
}
