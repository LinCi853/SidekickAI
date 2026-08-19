// electron/stt/languages.ts — 语言映射表（Mimo / 本地引擎共享）

/**
 * 语言名映射：语言代码 -> 中文描述（供 Mimo ASR 提示词使用）
 */
export const langNameMap: Record<string, string> = {
  zh: '中文（普通话）',
  'zh-cn': '中文（普通话）',
  en: '英文',
  ja: '日文',
  ko: '韩文',
  fr: '法文',
  de: '德文',
  es: '西班牙文',
  ru: '俄文',
  auto: '原声语种（自动判断）',
}

/**
 * 语言代码映射：语言代码 -> whisper.cpp / FunASR 通用语种码（本地引擎使用）
 */
export const langCodeMap: Record<string, string> = {
  zh: 'zh',
  'zh-cn': 'zh',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
  fr: 'fr',
  de: 'de',
  es: 'es',
  ru: 'ru',
}
