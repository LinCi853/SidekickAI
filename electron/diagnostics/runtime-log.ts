import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { localLogDate } from '../shared/log-export.js'

export function redactDiagnostic(value: string): string {
  if (/^\[(?:voice|SttEngine|chinese-convert)\].*(?:识别结果|原始返回|清洗解释性前缀|繁→简)/.test(value))
    return `${value.split(':', 1)[0]}: [content omitted]`
  return value.replace(/\bhttps?:\/\/[^\s<>"']+/gi, raw => {
    try { const url = new URL(raw); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href }
    catch { return '[url]' }
  }).replace(/(\b(?:authorization|cookie|set-cookie|password|api[-_]?key|access[-_]?token|refresh[-_]?token|secret)\b["']?\s*[:=]\s*)[^\r\n,}]+/gi, '$1[redacted]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
}

export function createRuntimeLog(directory: string, options: { now?: () => Date; maxBytes?: number } = {}) {
  const now = options.now ?? (() => new Date())
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024
  const identity = `${process.pid}-${randomUUID()}`
  let day = '', sequence = 0, size = 0
  let failures = 0
  let prepared = false
  return {
    get failures() { return failures },
    write(level: string, source: string, values: unknown[]) {
      try {
        const date = now(), nextDay = localLogDate(date)
        if (day !== nextDay) { if (day) sequence++; day = nextDay; size = 0 }
        const message = values.map(value => value instanceof Error ? value.stack || value.message
          : typeof value === 'string' ? value : value === null || typeof value !== 'object' ? String(value) : '[object]').join(' ')
        const line = Buffer.from(`${JSON.stringify({ timestamp: date.toISOString(), level, source, message: redactDiagnostic(message).slice(0, 24000) })}\n`)
        if (size && size + line.length > maxBytes) { sequence++; size = 0 }
        if (!prepared) { fs.mkdirSync(directory, { recursive: true }); prepared = true }
        fs.appendFileSync(path.join(directory, `${day}-${identity}-${sequence}.jsonl`), line, { mode: 0o600 })
        size += line.length
      } catch { prepared = false; failures++ }
    },
  }
}
