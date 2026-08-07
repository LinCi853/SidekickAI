// proxy.types.ts — 代理配置共享类型定义
//
// Profile 级独立代理配置（proxyConfig）的完整对象结构。
// 与主窗口全局 AppSettings 代理字段一一对应，使每个 AI 应用窗口可拥有独立的代理设置。
// 优先级：Profile.proxyConfig（结构化）> Profile.proxy（旧字符串，兼容）> 全局 AppSettings。

/** Profile 级代理配置（完整对象） */
export interface ProfileProxyConfig {
  /** 代理模式：system=系统代理 direct=直连 custom=自定义 */
  proxyMode: 'system' | 'direct' | 'custom'
  /** 自定义代理地址（proxyMode=custom 时有效，如 http://127.0.0.1:7890） */
  customProxy: string
  /** 代理认证用户名（可选） */
  proxyUsername: string
  /** 代理认证密码（可选） */
  proxyPassword: string
  /** 代理绕过列表（逗号分隔域名，不走代理） */
  proxyBypass: string
  /** 代理失败兜底：custom 代理加载失败时自动切换到兜底模式 */
  proxyFallbackEnabled: boolean
  /** 代理失败兜底模式：direct=直连 / system=系统代理 */
  proxyFallbackMode: 'direct' | 'system'
}
