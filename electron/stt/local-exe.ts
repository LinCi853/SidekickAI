// electron/stt/local-exe.ts — 本地 EXE 引擎

import { app } from 'electron'
import path from 'path'
import { spawn } from 'child_process'
import { writeFile, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { SAMPLE_RATE } from './constants.js'
import { encodeWav } from './wav.js'
import { langCodeMap } from './languages.js'
import { convertTraditionalToSimplified } from './chinese-convert.js'

/**
 * 本地识别软件
 * 将 PCM 写入临时 WAV，调用用户配置的可执行文件，读取 stdout 作为识别结果。
 * localExePath: 可执行文件路径
 * localArgs: 启动参数（支持 {wav} 占位符替换为 WAV 文件路径）
 *
 * 中文适配策略：
 * - 用户已显式填写 localArgs：完全尊重，不做任何修改
 * - localArgs 为空时：注入默认中文语种参数 `-l <lang>`，兼容主流本地引擎：
 *   - whisper.cpp / whisper-cli：-l zh 指定识别语种
 *   - FunASR：--lang zh / 同名参数
 *   - vosk：通过 -l 传递语言（少数版本支持）
 * - 用户可在设置中手动覆盖 localArgs 以适配其他语种或自定义参数
 */
export async function recognizeWithLocalExe(
  pcm: Float32Array,
  config: { localExePath: string; localArgs: string; language?: string },
): Promise<string> {
  if (!config.localExePath) {
    console.info('[SttEngine] 本地识别软件路径未配置，跳过')
    return ''
  }
  if (!existsSync(config.localExePath)) {
    console.error('[SttEngine] 本地识别软件不存在:', config.localExePath)
    return ''
  }

  const wavPath = path.join(app.getPath('temp'), `ai-window-stt-local-${Date.now()}.wav`)
  try {
    const wavBuf = encodeWav(pcm, SAMPLE_RATE)
    await writeFile(wavPath, wavBuf)
  } catch (err) {
    console.error('[SttEngine] 写入临时 WAV 失败:', err)
    return ''
  }

  // ---- 参数组装 ----
  // ISO 639-1 简写 -> whisper.cpp / FunASR 通用语种码（仅在 auto 时不传 -l）
  const language = (config.language || 'zh').toLowerCase()
  const langCode = langCodeMap[language] || (language === 'auto' ? '' : language)

  let argsString: string
  if (config.localArgs && config.localArgs.trim()) {
    // 用户已显式填写：原样使用，不做任何修改（避免覆盖高级用户的调参）
    argsString = config.localArgs
    console.log(`[SttEngine] 本地识别使用用户自定义参数: ${argsString}`)
  } else if (langCode) {
    // 用户未填：注入中文（默认）语种参数，{wav} 占位符稍后替换
    argsString = `-l ${langCode} {wav}`
    console.log(`[SttEngine] 本地识别注入默认中文语种参数: ${argsString}`)
  } else {
    // auto 模式且未填 args：仅传音频路径
    argsString = '{wav}'
    console.log('[SttEngine] 本地识别使用 auto 模式（无 -l 参数）')
  }

  return new Promise<string>((resolve) => {
    const args = argsString
      .split(/\s+/)
      .filter(Boolean)
      .map((a) => a.replace('{wav}', wavPath))
    console.log('[SttEngine] 本地识别执行命令:', config.localExePath, args.join(' '))
    const proc = spawn(config.localExePath, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('error', (err) => {
      console.error('[SttEngine] 本地识别软件启动失败:', err.message)
      resolve('')
    })
    proc.on('exit', (code) => {
      if (code !== 0) {
        console.error(`[SttEngine] 本地识别软件退出码 ${code}: ${stderr.slice(-256)}`)
      }
      // 繁→简转换：本地引擎也可能输出繁体
      resolve(convertTraditionalToSimplified(stdout.trim()))
    })
  }).finally(() => {
    void unlink(wavPath).catch(() => {})
  })
}
