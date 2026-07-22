/**
 * STT 响应清洗共享模块
 *
 * 从 electron/stt/engine.ts 提取的 Mimo ASR 响应清洗逻辑，
 * 供主进程（Electron）与渲染层（移动端）共用。
 *
 * 清洗步骤：
 * 1. 占位文本检测（"(speaking in foreign language)" 等 16 种模式）
 * 2. 翻译行为检测（期望中文但返回纯英文 → 丢弃）
 * 3. 解释性前缀清洗（"Speaker says: xxx" / "字幕：xxx" 等）
 *
 * 注意：繁→简转换不在此模块内，调用方按需调用 convertTraditionalToSimplified()。
 */

/**
 * 清洗 Mimo ASR 响应文本。
 * @param text Mimo ASR 返回的原始文本（choices[0].message.content）
 * @param expectChinese 是否期望中文输出（language=zh 或 auto 时为 true）
 * @returns 清洗后的文本，空字符串表示应视为空结果
 */
export function cleanMimoResponse(text: string, expectChinese: boolean = true): string {
  if (!text) return ''

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
    "i can't transcribe",
    '无法转录',
    '无法识别',
  ]
  const lower = text.toLowerCase()
  for (const ph of placeholders) {
    if (lower.includes(ph.toLowerCase())) {
      console.warn(`[stt-cleaner] Mimo ASR 返回占位文本 "${ph}"，视为空结果`)
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
        `[stt-cleaner] Mimo ASR 输出疑似英文翻译（无中文字符），原结果: "${text.slice(0, 100)}"`,
      )
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
  let cleaned = text
  for (const pat of explanationPatterns) {
    const m = cleaned.match(pat)
    if (m && m[1] !== undefined) {
      console.log(`[stt-cleaner] 清洗解释性前缀: "${cleaned}" → "${m[1]}"`)
      cleaned = m[1].trim()
      break
    }
  }

  return cleaned
}
