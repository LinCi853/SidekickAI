import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { LoginTrace, WindowTrace } from '../shared/chat.types.js'

export interface ActivityLogRecords {
  loginRecords: Array<Pick<LoginTrace, 'id' | 'profileId' | 'platform' | 'loginUrl' | 'loginTime'>>
  windowRecords: Array<Pick<WindowTrace, 'id' | 'windowId' | 'action' | 'timestamp'>>
}

const pending = new Map<string, Promise<void>>()

export function openActivityLogFolder(
  dataDirectory: string,
  readRecords: () => ActivityLogRecords,
  openPath: (directory: string) => Promise<string>,
): Promise<void> {
  const directory = path.join(dataDirectory, 'logs')
  const known = pending.get(directory)
  if (known) return known
  const operation = exportAndOpen(directory, readRecords, openPath)
  pending.set(directory, operation)
  void operation.then(() => pending.delete(directory), () => pending.delete(directory))
  return operation
}

async function exportAndOpen(
  directory: string,
  readRecords: () => ActivityLogRecords,
  openPath: (directory: string) => Promise<string>,
): Promise<void> {
  await fs.mkdir(directory, { recursive: true })
  const records = readRecords()
  const snapshot = {
    exportedAt: new Date().toISOString(),
    counts: { loginRecords: records.loginRecords.length, windowRecords: records.windowRecords.length },
    ...records,
  }
  const temporary = path.join(directory, `.activity-records-${randomUUID()}.tmp`)
  let created = false
  try {
    const file = await fs.open(temporary, 'wx')
    created = true
    try { await file.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8') }
    finally { await file.close() }
    await fs.rename(temporary, path.join(directory, 'activity-records.json'))
  } finally {
    if (created) await fs.unlink(temporary).catch(() => {})
  }
  const error = await openPath(directory)
  if (error) throw new Error(`Unable to open logs folder: ${error}`)
}
