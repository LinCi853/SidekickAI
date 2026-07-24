// electron/utils/zip-extractor.ts — zip 解压工具
//
// 提供：
//   - extractZip：解压 zip 到目标目录（跨平台），根据环境选择 PowerShell 或 adm-zip
//   - extractZipViaPowerShell：使用 PowerShell Expand-Archive 解压（仅 Windows）
//   - extractZipViaAdmZip：使用 adm-zip 解压（跨平台，纯 JS）
//
// 从 electron/ipc/voice-ipc.ts 抽离，保持函数实现细节不变。

import * as fs from 'fs'
import * as path from 'path'
import { exec } from 'child_process'
import AdmZip from 'adm-zip'
import { WHISPER_CLI_BINARIES } from '../stt/binary-resolver.js'

/**
 * 解压 zip 到目标目录（跨平台）。
 *
 * 策略：
 *   - Windows：优先尝试 PowerShell Expand-Archive（原生性能更好），失败回退 adm-zip
 *   - macOS / Linux：直接使用 adm-zip（纯 JS，无原生依赖）
 *
 * 解压后会把子目录中的可执行文件平铺到 destDir 根目录（whisper.cpp release 的 zip
 * 内部通常带 whisper-bin-x64/ 之类的子目录）。
 */
export async function extractZip(zipPath: string, destDir: string): Promise<void> {
  // Windows 优先尝试 PowerShell（性能更好），失败回退 adm-zip
  if (process.platform === 'win32') {
    try {
      await extractZipViaPowerShell(zipPath, destDir)
      return
    } catch (err) {
      console.warn('[voice-ipc] PowerShell 解压失败，回退到 adm-zip:', err)
    }
  }
  await extractZipViaAdmZip(zipPath, destDir)
}

/** 使用 PowerShell Expand-Archive 解压（仅 Windows） */
export function extractZipViaPowerShell(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Expand-Archive 解压后可能有子目录（如 whisper-bin-x64/），
    // 解压后把里面的可执行文件移到 destDir 根目录
    const tmpExtract = path.join(destDir, '_tmp_extract_' + Date.now())
    const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${tmpExtract}' -Force; Get-ChildItem -Path '${tmpExtract}' -Recurse -File | Move-Item -Destination '${destDir}' -Force; Remove-Item -Path '${tmpExtract}' -Recurse -Force"`
    exec(cmd, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(`PowerShell 解压失败：${stderr || err.message}`))
        return
      }
      // 验证解压后是否真的产出了可执行文件
      const possibleNames = WHISPER_CLI_BINARIES
      const found = possibleNames.some((n) => fs.existsSync(path.join(destDir, n)))
      if (!found) {
        reject(new Error('PowerShell 解压完成但未找到可执行文件（zip 内容可能不包含预期二进制）'))
        return
      }
      resolve()
    })
  })
}

/**
 * 使用 adm-zip 解压（跨平台，纯 JS）。
 * 解压后将所有条目平铺到 destDir 根目录（去掉 zip 内部的子目录层级），
 * 与 PowerShell 路径的产出结构保持一致。
 */
export async function extractZipViaAdmZip(zipPath: string, destDir: string): Promise<void> {
  const zip = new AdmZip(zipPath)
  const entries = zip.getEntries()
  if (entries.length === 0) {
    throw new Error('zip 包为空')
  }
  fs.mkdirSync(destDir, { recursive: true })
  // maintainEntryPath=false：把条目平铺到 destDir 根目录（去掉 zip 内部子目录）
  // overwrite=true：同名文件直接覆盖，避免残留旧版本
  for (const entry of entries) {
    if (entry.isDirectory) continue
    zip.extractEntryTo(entry, destDir, false, true)
  }
  // 验证解压后是否真的产出了可执行文件
  const possibleNames = WHISPER_CLI_BINARIES
  const found = possibleNames.some((n) => fs.existsSync(path.join(destDir, n)))
  if (!found) {
    let listed: string[] = []
    try { listed = fs.readdirSync(destDir) } catch { /* ignore */ }
    throw new Error(`adm-zip 解压完成但未找到可执行文件（实际产出: ${listed.join(', ')}）`)
  }
}
