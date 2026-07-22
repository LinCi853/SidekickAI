/* =====================================================================
   lib/prompt-placeholders.ts —— 提示词模板组合 + 占位符替换
   - {{body}}：当前输入框内容
   ===================================================================== */

import type { PromptTemplate } from '../../electron/shared/types';

/** 占位符替换上下文 */
export interface PlaceholderContext {
  /** 当前输入框内容（webview 抓取） */
  body: string;
}

/**
 * 模板组合 + 占位符替换：仅替换 {{body}} 占位符。
 *
 * @example
 * composeFinalText(
 *   { content: '翻译成英文：{{body}}' },
 *   { body: '你好' }
 * );
 * // → '翻译成英文：你好'
 */
export function composeFinalText(
  template: Pick<PromptTemplate, 'content'>,
  context: PlaceholderContext,
): string {
  return (template.content ?? '').replace(/\{\{body\}\}/g, context.body ?? '');
}
