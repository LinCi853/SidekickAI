// electron/stt/ai-whisper.ts — Whisper AI 引擎

import { SAMPLE_RATE } from './constants.js'
import { encodeWav } from './wav.js'
import { httpPostMultipart } from './http-client.js'
import { convertTraditionalToSimplified } from './chinese-convert.js'
import type { CustomAIProvider } from '../shared/chat.types.js'

/**
 * 标准 OpenAI Whisper 识别（multipart/form-data 上传 WAV）
 * 使用 Electron net.request 走应用代理设置
 */
export async function recognizeWithOpenAiWhisper(
  pcm: Float32Array,
  provider: CustomAIProvider,
  endpoint: string,
  language?: string,
): Promise<string> {
  const wavBuf = encodeWav(pcm, SAMPLE_RATE)
  const model = provider.sttModel || 'whisper-1'

  // 构建 multipart/form-data
  const boundary = '----ai-window-stt-' + Date.now()
  const parts: Buffer[] = []

  // model 字段
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`))
  // file 字段（WAV 音频）
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
  ))
  parts.push(wavBuf)
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))

  const body = Buffer.concat(parts)
  return httpPostMultipart(endpoint, body, boundary, provider.apiKey, 'OpenAI Whisper').then(
    (data) => {
      try {
        const json = JSON.parse(data)
        // 繁→简转换：Mimo/OpenAI 也有可能输出繁体
        return convertTraditionalToSimplified(json.text?.trim() || '')
      } catch (e) {
        console.error('[SttEngine] OpenAI Whisper 响应 JSON 解析失败:', e, data.slice(0, 200))
        return ''
      }
    },
  )
}
