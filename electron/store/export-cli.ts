// electron/store/export-cli.ts — 卸载器/脚本用的无界面导出入口
//
// 与软件内「数据迁移 → 导出」共用 exportAllData 同一套实现（backup-restore.ts），
// 保证卸载备份与应用内备份内容、分类、加密格式完全一致。
//
// 调用：SidekickAI.exe --export-user-data <request.json>
// 请求 JSON：{ outputPath, encrypt?, password?, categories?: string[] }
// 结果 JSON：写到 outputPath + '.result.json' 或请求内 resultPath

import { writeFileSync } from 'fs'
import path from 'path'
import { exportAllData, type ExportOptions } from './backup-restore.js'

export interface ExportCliRequest {
  outputPath: string
  encrypt?: boolean
  password?: string
  /** basicData / cookies / indexedDB / cache；空或缺省 = 推荐（basic+cookies+indexedDB） */
  categories?: string[]
  /** 结果文件路径；缺省 = outputPath + '.result.json' */
  resultPath?: string
}

function normalizeOptions(categories?: string[]): ExportOptions {
  // 主程序 ExportOptions 仅支持 4 类；voiceAssets 等其它项忽略
  if (!categories || categories.length === 0) {
    return { basicData: true, cookies: true, indexedDB: true, cache: false }
  }
  const set = new Set(categories.filter((c) => c !== 'voiceAssets'))
  return {
    basicData: true, // 导入校验依赖 settings.db，始终包含
    cookies: set.has('cookies'),
    indexedDB: set.has('indexedDB'),
    cache: set.has('cache'),
  }
}

/**
 * 执行 CLI 导出。返回进程退出码（0 成功）。
 * 结果 JSON：{ ok, filePath?, error? }
 */
export async function runExportCli(requestPath: string): Promise<number> {
  let resultPath = `${requestPath}.result.json`
  try {
    const raw = JSON.parse(await (await import('fs/promises')).readFile(requestPath, 'utf-8')) as ExportCliRequest
    resultPath = raw.resultPath || `${raw.outputPath}.result.json`
    if (!raw.outputPath) {
      writeFileSync(resultPath, JSON.stringify({ ok: false, error: '缺少 outputPath' }))
      return 1
    }
    const options = normalizeOptions(raw.categories)
    const encrypt = raw.encrypt && raw.password ? { password: raw.password } : undefined
    if (raw.encrypt && !raw.password) {
      writeFileSync(resultPath, JSON.stringify({ ok: false, error: 'encrypt=true 但未提供 password' }))
      return 1
    }
    const result = await exportAllData(raw.outputPath, options, encrypt)
    writeFileSync(
      resultPath,
      JSON.stringify({
        ok: result.success,
        filePath: result.filePath,
        error: result.error,
        options,
      }),
    )
    return result.success ? 0 : 1
  } catch (err) {
    try {
      writeFileSync(resultPath, JSON.stringify({ ok: false, error: (err as Error).message }))
    } catch { /* ignore */ }
    return 1
  }
}

/** 从 argv 提取 --export-user-data 的请求文件路径 */
export function parseExportCliArgv(argv: string[]): string | null {
  const i = argv.indexOf('--export-user-data')
  if (i === -1) return null
  const p = argv[i + 1]
  return p && !p.startsWith('--') ? p : null
}

export function defaultResultPath(outputPath: string): string {
  return `${path.resolve(outputPath)}.result.json`
}
