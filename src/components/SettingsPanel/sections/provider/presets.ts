/* =====================================================================
   SettingsPanel/sections/provider/presets —— 供应商预设数据与协议推断
   从 ProviderSection.tsx 拆出（纯数据/逻辑，无 React 依赖）。
   ===================================================================== */

/** API 协议类型 */
export type ProviderProtocol = 'openai' | 'anthropic' | 'custom'

/** 供应商来源预设条目 */
export interface ProviderPreset {
  id: string
  label: string
  protocol: ProviderProtocol
  endpoint: string
  model: string
  region: 'domestic' | 'foreign'
}

/** 供应商来源预设（2026 热门模型，覆盖国内外主流厂商 + Coding Plan + 聚合平台）
 *  region: 'domestic' 国内 | 'foreign' 国外
 *  region 字段仅作为 tag 显示用，所有预设始终展示（不做过滤）
 */
export const PRESETS: ProviderPreset[] = [
  // ===== 国际主流 =====
  { id: 'openai', label: 'OpenAI', protocol: 'openai', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', region: 'foreign' },
  { id: 'anthropic', label: 'Anthropic Claude', protocol: 'anthropic', endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-4-5', region: 'foreign' },
  { id: 'gemini', label: 'Google Gemini', protocol: 'openai', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-2.5-pro', region: 'foreign' },
  { id: 'groq', label: 'Groq', protocol: 'openai', endpoint: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile', region: 'foreign' },
  { id: 'openrouter', label: 'OpenRouter', protocol: 'openai', endpoint: 'https://openrouter.ai/api/v1/chat/completions', model: 'openai/gpt-4o-mini', region: 'foreign' },
  { id: 'together', label: 'Together AI', protocol: 'openai', endpoint: 'https://api.together.xyz/v1/chat/completions', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', region: 'foreign' },
  { id: 'mistral', label: 'Mistral AI', protocol: 'openai', endpoint: 'https://api.mistral.ai/v1/chat/completions', model: 'mistral-large-latest', region: 'foreign' },
  { id: 'cohere', label: 'Cohere', protocol: 'openai', endpoint: 'https://api.cohere.ai/v1/chat/completions', model: 'command-r-plus', region: 'foreign' },
  { id: 'fireworks', label: 'Fireworks AI', protocol: 'openai', endpoint: 'https://api.fireworks.ai/inference/v1/chat/completions', model: 'accounts/fireworks/models/llama-v3p1-70b-instruct', region: 'foreign' },
  { id: 'perplexity', label: 'Perplexity', protocol: 'openai', endpoint: 'https://api.perplexity.ai/chat/completions', model: 'llama-3.1-sonar-large-32k-online', region: 'foreign' },
  { id: 'xai', label: 'xAI Grok', protocol: 'openai', endpoint: 'https://api.x.ai/v1/chat/completions', model: 'grok-3', region: 'foreign' },
  { id: 'deepinfra', label: 'DeepInfra', protocol: 'openai', endpoint: 'https://api.deepinfra.com/v1/openai/chat/completions', model: 'meta-llama/Llama-3.3-70B-Instruct', region: 'foreign' },
  { id: 'lepton', label: 'Lepton AI', protocol: 'openai', endpoint: 'https://api.lepton.ai/v1/chat/completions', model: 'llama3-70b', region: 'foreign' },
  { id: 'novita', label: 'Novita AI', protocol: 'openai', endpoint: 'https://api.novita.ai/v3/openai/chat/completions', model: 'llama3.1-70b-instruct', region: 'foreign' },
  { id: 'chutes', label: 'Chutes AI', protocol: 'openai', endpoint: 'https://api.chutes.ai/v1/chat/completions', model: 'chutes/llama-3.3-70b', region: 'foreign' },
  // ===== 国内主流 =====
  { id: 'deepseek', label: 'DeepSeek 深度求索', protocol: 'openai', endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat', region: 'domestic' },
  { id: 'qwen', label: '通义千问 (阿里百炼)', protocol: 'openai', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus', region: 'domestic' },
  { id: 'kimi', label: 'Kimi (月之暗面)', protocol: 'openai', endpoint: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-8k', region: 'domestic' },
  { id: 'zhipu', label: '智谱 GLM', protocol: 'openai', endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4-flash', region: 'domestic' },
  { id: 'doubao', label: '豆包 (火山方舟)', protocol: 'openai', endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', model: 'doubao-pro-32k', region: 'domestic' },
  { id: 'ernie', label: '百度文心 ERNIE', protocol: 'openai', endpoint: 'https://qianfan.baidubce.com/v2/chat/completions', model: 'ernie-4.0-8k', region: 'domestic' },
  { id: 'hunyuan', label: '腾讯混元', protocol: 'openai', endpoint: 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions', model: 'hunyuan-pro', region: 'domestic' },
  { id: 'minimax', label: 'MiniMax', protocol: 'openai', endpoint: 'https://api.minimax.chat/v1/chat/completions', model: 'MiniMax-M2.5', region: 'domestic' },
  { id: 'baichuan', label: '百川大模型', protocol: 'openai', endpoint: 'https://api.baichuan-ai.com/v1/chat/completions', model: 'Baichuan4-Turbo', region: 'domestic' },
  { id: 'stepfun', label: '阶跃星辰 StepFun', protocol: 'openai', endpoint: 'https://api.stepfun.com/v1/chat/completions', model: 'step-2-16k', region: 'domestic' },
  { id: 'lingyi', label: '零一万物 (01.AI)', protocol: 'openai', endpoint: 'https://api.lingyiwanwu.com/v1/chat/completions', model: 'yi-large', region: 'domestic' },
  { id: 'tiangong', label: '昆仑万维 天工', protocol: 'openai', endpoint: 'https://api.tiangong.cn/v1/chat/completions', model: 'Skywork-4.0', region: 'domestic' },
  { id: 'sensetime', label: '商汤 SenseChat', protocol: 'openai', endpoint: 'https://api.sensenova.cn/compatible-mode/v1/chat/completions', model: 'SenseChat-5', region: 'domestic' },
  { id: 'mimo', label: '小米 MiMo (按量付费)', protocol: 'openai', endpoint: 'https://api.xiaomimimo.com/v1/chat/completions', model: 'mimo-v2.5-pro', region: 'domestic' },
  { id: 'mimo-plan', label: '小米 MiMo (Token Plan 订阅)', protocol: 'openai', endpoint: 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions', model: 'mimo-v2.5-pro', region: 'domestic' },
  // ===== Coding / 开发专用 =====
  { id: 'github-copilot', label: 'GitHub Copilot', protocol: 'openai', endpoint: 'https://api.githubcopilot.com/chat/completions', model: 'gpt-4o', region: 'foreign' },
  { id: 'codegeex', label: 'CodeGeeX (智谱)', protocol: 'openai', endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'codegeex-4-all-9b', region: 'domestic' },
  { id: 'codestral', label: 'Codestral (Mistral 编程)', protocol: 'openai', endpoint: 'https://api.mistral.ai/v1/chat/completions', model: 'codestral-latest', region: 'foreign' },
  { id: 'deepseek-coder', label: 'DeepSeek Coder', protocol: 'openai', endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-coder', region: 'domestic' },
  { id: 'qwen-coder', label: '通义千问 Coder', protocol: 'openai', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-coder-plus', region: 'domestic' },
  { id: 'codebuddy', label: '腾讯 CodeBuddy', protocol: 'openai', endpoint: 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions', model: 'codebuddy-code', region: 'domestic' },
  // ===== 聚合平台 =====
  { id: 'siliconflow', label: '硅基流动 SiliconFlow', protocol: 'openai', endpoint: 'https://api.siliconflow.cn/v1/chat/completions', model: 'deepseek-ai/DeepSeek-V3', region: 'domestic' },
  { id: 'modelscope', label: '魔搭 ModelScope (阿里)', protocol: 'openai', endpoint: 'https://api-inference.modelscope.cn/v1/chat/completions', model: 'Qwen/Qwen2.5-72B-Instruct', region: 'domestic' },
  { id: 'dmxapi', label: 'DMXAPI 聚合', protocol: 'openai', endpoint: 'https://www.dmxapi.cn/v1/chat/completions', model: 'gpt-4o-mini', region: 'domestic' },
  { id: 'aihubmix', label: 'AiHubMix 聚合', protocol: 'openai', endpoint: 'https://aihubmix.com/v1/chat/completions', model: 'gpt-4.1-free', region: 'foreign' },
  { id: 'oneapi', label: 'OneAPI 聚合', protocol: 'openai', endpoint: 'https://api.oneapi.pro/v1/chat/completions', model: 'gpt-4o-mini', region: 'foreign' },
];

/** 根据端点 URL 自动推断协议 */
export function detectProtocol(endpoint: string): ProviderProtocol {
  const lower = endpoint.toLowerCase();
  if (lower.includes('anthropic.com') || lower.endsWith('/v1/messages')) return 'anthropic';
  return 'openai'; // 绝大多数供应商兼容 OpenAI 格式
}
