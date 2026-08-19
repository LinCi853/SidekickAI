// electron/stt/ai-mimo.ts — Mimo AI 引擎

import { SAMPLE_RATE } from './constants.js'
import { encodeWav } from './wav.js'
import { langNameMap } from './languages.js'
import { httpPostJson } from './http-client.js'
import { convertTraditionalToSimplified } from './chinese-convert.js'
import type { CustomAIProvider } from '../shared/chat.types.js'

/**
 * Mimo ASR 识别（通过 chat completions 接口）
 * 将音频转为 Base64 data URL，作为 input_audio 内容发送
 * 使用 Electron net.request 走应用代理设置（system/custom/direct）
 *
 * 关键修复（解决 net::ERR_INVALID_ARGUMENT）：
 * - **不要**手动设置 Content-Length：net.request 会自行计算并切分 chunked，
 *   手动设置一旦与实际写入字节数不一致（哪怕差 1 字节）就会抛出 ERR_INVALID_ARGUMENT。
 * - body 统一转为 Buffer 后再 req.write()，避免字符串编码歧义。
 *
 * 关键修复（解决"中文输出 (speaking in foreign language) 占位符"）：
 * - mimo-v2.5-asr 是基于 chat completions 的大模型，对 asr_options 异常敏感。
 *   之前传 `asr_options.language: 'zh'` + `asr_options.task: 'transcribe'` 时，
 *   模型把它当成"翻译到中文"任务；当音频被判别为非中文（如噪声、静音）时
 *   输出 "(speaking in foreign language)" 等占位文本。
 * - 关键洞察：**完全不传 asr_options**，仅靠 system + user 强提示词引导模型做转写。
 * - 加 temperature=0 让输出更确定，避免模型自由发挥。
 *
 * 关键修复（解决"中文被翻译成英文"）：
 * - 本地 Mimo 服务有时是通用 chat 模型，对 system 指令服从度低
 * - 改为"全压 system 提示 + user 消息只发音频"，减少模型把 user 文本当翻译目标的可能
 * - 后处理兜底：若设置语言为中文但输出不含任何中文字符，视为翻译结果丢弃
 */
export async function recognizeWithMimoAsr(
  pcm: Float32Array,
  provider: CustomAIProvider,
  language?: string,
): Promise<string> {
  const wavBuf = encodeWav(pcm, SAMPLE_RATE)
  const base64Audio = wavBuf.toString('base64')
  const dataUrl = `data:audio/wav;base64,${base64Audio}`

  // 端点：使用 provider 的 apiEndpoint
  let endpoint = provider.apiEndpoint
  if (!endpoint) {
    throw new Error('未配置 AI 语音识别端点，请在设置中配置或切换到本地识别模式')
  }
  // 如果端点不以 /chat/completions 结尾，自动补全
  if (!endpoint.endsWith('/chat/completions')) {
    endpoint = endpoint.replace(/\/$/, '') + '/chat/completions'
  }

  // 输入过大警告：Mimo API 通常支持 ~25MB 输入，115200 样本的 base64 大约 300KB，远低于上限
  const AUDIO_DURATION_WARN_MS = 5 * 60 * 1000
  const audioDurationMs = (pcm.length / SAMPLE_RATE) * 1000
  if (audioDurationMs > AUDIO_DURATION_WARN_MS) {
    console.warn(`[SttEngine] 音频时长 ${(audioDurationMs / 1000).toFixed(1)}s 较长，可能超时请耐心等待`)
  }

  // 语言提示：仅作为弱偏好，不传 asr_options.language
  const langNorm = (language || 'auto').toLowerCase()
  const langDesc = langNameMap[langNorm] || `${langNorm}（按该语种转写）`
  const expectChinese = langNorm === 'zh' || langNorm === 'zh-cn' || langNorm === 'auto'

  // system 提示：把"严禁翻译"和"严禁占位符"放在最前面，用最强约束
  // 关键是 system 消息要让模型明确：只输出原话，不输出任何其他东西
  const systemPrompt = [
    '【最高优先级】你是一个语音转写器，不是翻译器。',
    '',
    '用户提供的 audio 是某人说话的录音。',
    `用户的预期输出语种：${langDesc}`,
    '',
    '【绝对禁止】',
    '1. 禁止翻译。说话人说中文就输出中文，说英文就输出英文。绝对不要把中文翻译成英文。',
    '2. 禁止输出 "(speaking in foreign language)"、"[foreign language]"、"无法识别" 等任何占位文本。',
    '3. 禁止添加任何解释、注释、Markdown 标记、引号。',
    '4. 禁止总结、润色、改写、补全。',
    '',
    '【正确做法】',
    '- 听完 audio 后，把听到的原话逐字敲出来，用说话人使用的语种。',
    '- 听不清的部分可以跳过（不写），但不要编造占位符。',
    '- 如果整个 audio 都没听清，就输出一个空字符串。',
    '',
    '【示例】',
    '- audio 是 "你好世界" → 输出 "你好世界"',
    '- audio 是 "Hello world" → 输出 "Hello world"',
    '- audio 是 "你好世界" 且用户要求输出英文 → 输出 "你好世界"（仍是原话，不要翻译成 "Hello world"）',
    '',
    '再次强调：原话转写，不翻译，不润色，不占位。',
  ].join('\n')

  // 关键：user 消息只发音频，不再加 text 指令
  // 原因：部分 chat 模型会把 user 中的文本指令当成"翻译目标语种"来理解
  // 比如 user 是 "请翻译成中文：[audio]" → 模型理解为"把 audio 翻译成中文"
  // 改为只发 audio，让 system 的指令生效
  const requestBody = JSON.stringify({
    model: provider.sttModel || 'mimo-v2.5-asr',
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          {
            type: 'input_audio',
            input_audio: {
              data: dataUrl,
              format: 'wav',
            },
          },
        ],
      },
    ],
    temperature: 0,
  })

  return httpPostJson(endpoint, requestBody, provider.apiKey, 'Mimo ASR').then(
    (data) => {
      // Mimo ASR 返回 chat completions 格式，文本在 choices[0].message.content
      try {
        const json = JSON.parse(data)
        let text = json.choices?.[0]?.message?.content?.trim() || ''
        console.log('[SttEngine] Mimo ASR 原始返回:', text.slice(0, 200))

        // 兜底 1：清洗模型常见的占位输出
        const placeholders = [
          '(speaking in foreign language)',
          '[speaking in foreign language]',
          '(foreign language)',
          '[foreign language]',
          '(unintelligible)',
          '[unintelligible]',
          '说外语',
          '正在说外语',
          '在用外语说话',
          'speak foreign language',
          'speaking in a foreign language',
          'i cannot transcribe',
          'i can\'t transcribe',
          '无法转录',
          '无法识别',
        ]
        const lower = text.toLowerCase()
        for (const ph of placeholders) {
          if (lower.includes(ph.toLowerCase())) {
            console.warn(`[SttEngine] Mimo ASR 返回占位文本 "${ph}"，视为空结果`)
            return ''
          }
        }

        // 兜底 2：检测"翻译"行为
        // 如果用户期望中文输出（language=zh 或 auto），但返回结果完全不含中文字符，
        // 且包含英文字母 → 高度怀疑是翻译结果，丢弃
        if (expectChinese) {
          const hasChinese = /[\u4e00-\u9fff]/.test(text)
          const hasEnglish = /[a-zA-Z]{3,}/.test(text) // 至少 3 个连续英文字母
          if (!hasChinese && hasEnglish && text.length > 5) {
            console.warn(
              `[SttEngine] Mimo ASR 输出疑似英文翻译（无中文字符），原结果: "${text.slice(0, 100)}"`,
            )
            console.warn('[SttEngine] 提示：Mimo 可能在做翻译而非转写，建议切换到 Whisper Small 引擎')
            return ''
          }
        }

        // 兜底 3：如果输出明显是模型在"自我解释"而非转写
        // 例：返回 "The speaker says: 你好" → 只取冒号后的内容
        // 也覆盖 "字幕：xxx" / "识别结果：xxx" / "转写：xxx" 等中文模型常见的前缀
        const explanationPatterns = [
          /^(the\s+)?speaker\s+(says?|is\s+saying)\s*[:：]\s*/i,
          /^(transcription|转写|识别结果|识别内容|字幕|实时字幕|subtitles?|captions?)\s*[:：]\s*/i,
          /^["「『](.+)["」』]$/, // 整体被引号包住
        ]
        for (const pat of explanationPatterns) {
          const m = text.match(pat)
          if (m && m[1] !== undefined) {
            console.log(`[SttEngine] Mimo ASR 清洗解释性前缀: "${text}" → "${m[1]}"`)
            text = m[1].trim()
            break
          }
        }

        // 兜底 4：繁→简转换（Mimo 对中文也常输出繁体）
        return convertTraditionalToSimplified(text)
      } catch (e) {
        console.error('[SttEngine] Mimo ASR 响应 JSON 解析失败:', e, data.slice(0, 200))
        return ''
      }
    },
  )
}
