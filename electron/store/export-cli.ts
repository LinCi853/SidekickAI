import { writeFileSync } from 'fs'
import path from 'path'
import { exportAllData, type ExportOptions } from './backup-restore.js'


const SUPPORTED_CATEGORIES = ['basicData', 'cookies', 'indexedDB', 'cache'] as const

export interface ExportCliRequest {
  outputPath: string
  encrypt?: boolean
  password?: string
  
  categories?: string[]
  
  resultPath?: string
  
  expectedDataRoot?: string
  
  strict?: boolean
}

function normalizeOptions(categories?: string[]): ExportOptions {
  if (!categories || categories.length === 0) {
    return { basicData: true, cookies: true, indexedDB: true, cache: false }
  }
  const set = new Set<string>()
  for (const category of categories) {
    if (!(SUPPORTED_CATEGORIES as readonly string[]).includes(category)) {
      throw new Error(`Unsupported backup category: ${category}`)
    }
    set.add(category)
  }
  return {
    basicData: true, 
    cookies: set.has('cookies'),
    indexedDB: set.has('indexedDB'),
    cache: set.has('cache'),
  }
}


export async function runExportCli(requestPath: string): Promise<number> {
  let resultPath = `${requestPath}.result.json`
  try {
    const raw = JSON.parse(await (await import('fs/promises')).readFile(requestPath, 'utf-8')) as ExportCliRequest
    resultPath = raw.resultPath || (raw.outputPath ? `${raw.outputPath}.result.json` : `${requestPath}.result.json`)
    if (!raw.outputPath) {
      writeFileSync(resultPath, JSON.stringify({ ok: false, error: '缺少 outputPath' }))
      return 1
    }
    const strict = raw.strict === true
    if (strict && (!raw.expectedDataRoot || !raw.expectedDataRoot.trim())) {
      writeFileSync(resultPath, JSON.stringify({ ok: false, error: 'strict export requires expectedDataRoot', strict: true }))
      return 1
    }
    const options = normalizeOptions(raw.categories)
    const encrypt = raw.encrypt && raw.password ? { password: raw.password } : undefined
    if (raw.encrypt && !raw.password) {
      writeFileSync(resultPath, JSON.stringify({ ok: false, error: 'encrypt=true 但未提供 password' }))
      return 1
    }
    const result = await exportAllData(
      raw.outputPath,
      options,
      encrypt,
      strict ? { strict: true, expectedDataRoot: raw.expectedDataRoot } : undefined,
    )
    if (result.success) {
      if (strict && !result.treeSha256) {
        // The native host requires the complete-tree digest; without it the
        // receipt must not claim a verified strict export.
        writeFileSync(resultPath, JSON.stringify({ ok: false, error: 'strict export did not produce a complete data-tree digest', strict: true }))
        return 1
      }
      writeFileSync(
        resultPath,
        JSON.stringify({
          ok: true,
          filePath: result.filePath,
          sourceRoot: result.sourceRoot,
          sourceEntries: result.sourceEntries ?? {},
          skippedFiles: result.skippedFiles ?? [],
          options: result.options ?? options,
          strict: result.strict === true,
          ...(result.treeSha256 ? { treeSha256: result.treeSha256 } : {}),
        }),
      )
      return 0
    }
    writeFileSync(resultPath, JSON.stringify({ ok: false, error: result.error }))
    return 1
  } catch (err) {
    try {
      writeFileSync(resultPath, JSON.stringify({ ok: false, error: (err as Error).message }))
    } catch { /* ignore */ }
    return 1
  }
}


export function parseExportCliArgv(argv: string[]): string | null {
  const i = argv.indexOf('--export-user-data')
  if (i === -1) return null
  const p = argv[i + 1]
  return p && !p.startsWith('--') ? p : null
}

export function defaultResultPath(outputPath: string): string {
  return `${path.resolve(outputPath)}.result.json`
}
