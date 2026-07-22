// block-rules.types.ts — 页面组件屏蔽规则类型定义

/** 屏蔽方式 */
export type BlockRuleType = 'css' | 'js'

/** 页面组件屏蔽规则 */
export interface BlockRule {
  /** 唯一标识（UUID） */
  id: string
  /** 域名匹配模式（glob），如 '*.chatgpt.com' 或 '*'（通配所有） */
  domainPattern: string
  /** 屏蔽方式：css=隐藏元素 / js=执行JS移除 */
  type: BlockRuleType
  /** CSS 选择器（type=css 时使用） */
  selector: string
  /** JS 代码（type=js 时使用，如重写 confirm/alert） */
  jsCode?: string
  /** 规则名称 */
  label: string
  /** 是否启用 */
  enabled: boolean
  /** 是否内置规则（内置规则不可删除） */
  builtin: boolean
}
