/**
 * 繁体中文 → 简体中文 转换工具
 *
 * Whisper.cpp 的多语种模型（如 ggml-small.bin）对中文音频的输出经常是繁体字
 * （香港、台湾的繁体书写习惯），但大陆用户实际输入需要的是简体。
 *
 * 使用 opencc-js 做转换：
 * - 词典精确：基于 OpenCC 官方词典，转换准确率接近 100%
 * - 体积小：opencc-js 懒加载词典，初始包 < 50KB
 *
 * opencc-js v1.4.0 API：
 *   import OpenCC from 'opencc-js'
 *   const converter = OpenCC.Converter({ from: 'tw', to: 'cn' })
 *   converter('漢語') === '汉语'
 *
 * 注意：
 * - 仅对包含中文字符的文本做转换（其他语言不处理）
 * - 转换失败时回退原文，不影响识别结果
 */
import OpenCC from 'opencc-js'

// opencc-js 暴露两种方式：
// 1) 默认导出：import OpenCC from 'opencc-js'   → OpenCC.Converter
// 2) 命名导出：import { Converter } from 'opencc-js' → Converter
// Vite SSR 打包时推荐用 default import，避免 namespace 解构兼容性问题
type ConverterFn = (text: string) => string
type ConverterFactory = (opts: { from: string; to: string }) => ConverterFn
type OpenCCLike = {
  Converter?: ConverterFactory
}

let cachedConverter: ConverterFn | null = null

/**
 * 取到 Converter 工厂函数（兼容默认导出 / 命名导出）
 */
function resolveConverterFactory(): ConverterFactory | null {
  const def = OpenCC as unknown as OpenCCLike
  if (def && typeof def.Converter === 'function') return def.Converter.bind(def)
  // 兜底：从模块 namespace 取
  const mod = (OpenCC as unknown as { Converter?: ConverterFactory })
  if (mod && typeof mod.Converter === 'function') return mod.Converter
  return null
}

/**
 * 加载繁体→简体转换器（单例）。
 * 使用台湾繁体（twp，含台湾惯用词）→ 大陆简体（cn，含大陆惯用词）的双向词库
 * 转换最彻底，能把"軟體/檔案/記憶體"等台繁用词也转成大陆用词"软件/文件/内存"。
 */
function getTraditionalToSimplifiedConverter(): ConverterFn | null {
  if (cachedConverter) return cachedConverter
  const factory = resolveConverterFactory()
  if (!factory) {
    console.warn('[chinese-convert] opencc-js 未导出 Converter，跳过转换')
    return null
  }
  try {
    const converter = factory({ from: 'twp', to: 'cn' })
    // 自检：确保 converter 真的能转换（防止 Vite SSR 打包后部分代码丢失导致 converter 静默失败）
    const selfTest = converter('測試')
    console.log(`[chinese-convert] 自检：factory=${typeof factory} converter=${typeof converter} "測試" → "${selfTest}"`)
    if (!selfTest || selfTest === '測試') {
      console.warn('[chinese-convert] 自检失败：converter 返回值异常（与原文相同或为空）')
    }
    cachedConverter = converter
    return cachedConverter
  } catch (err) {
    console.warn('[chinese-convert] 加载 opencc-js 转换器失败:', err)
    return null
  }
}

/**
 * 检测文本是否包含中文字符（CJK 统一表意文字 + 扩展 A 区）
 */
export function hasChinese(text: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(text)
}

/**
 * 将繁体中文转换为简体中文。
 * - 如果输入不含中文，直接返回原文
 * - 如果转换器未加载成功，返回原文（不影响主流程）
 * - 用于：whisper.cpp / Mimo / 任何 chat 模型输出的中文转写结果
 */
export function convertTraditionalToSimplified(text: string): string {
  if (!text) return text
  if (!hasChinese(text)) return text
  const converter = getTraditionalToSimplifiedConverter()
  if (!converter) return text
  try {
    const result = converter(text)
    if (result && result !== text) {
      console.log(`[chinese-convert] 繁→简: "${text.slice(0, 50)}" → "${result.slice(0, 50)}"`)
    }
    return result || text
  } catch (err) {
    console.warn('[chinese-convert] 转换失败，返回原文:', err)
    return text
  }
}
