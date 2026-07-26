// electron/ai/client.ts — OpenAI/Anthropic 兼容 API 客户端
//
// 支持：
//   - openai 协议：POST {endpoint} with Authorization: Bearer {apiKey}
//   - anthropic 协议：POST {endpoint} with x-api-key: {apiKey} + anthropic-version
//   - custom 协议：按 OpenAI 格式请求（用户自定义 endpoint）
//
// 流式响应（SSE）：使用 undici 手动解析 text/event-stream，
// 通过 onDelta 回调推送增量文本，onDone 回调通知结束。
//
// 不依赖第三方 SDK，仅用 undici（已在依赖中）+ 手写 SSE 解析，
// 避免引入 openai/anthropic SDK 带来的额外依赖与版本耦合。

import { request } from 'undici'
import type { CustomAIProvider, CustomAIProviderInput, ChatMessage } from '../shared/types.js'

/** 默认最大输出 token 数 */
const DEFAULT_MAX_TOKENS = 2048
/** Provider 连通性测试超时（毫秒） */
const PROVIDER_TEST_TIMEOUT_MS = 15000
/** 错误日志截断长度（API 错误响应体较长，保留 500 字符） */
const ERROR_LOG_MAX_LEN = 500
/** 错误日志截断长度（SSE 单行解析失败，保留 200 字符） */
const ERROR_LOG_MAX_LEN_SHORT = 200

/** 流式调用回调集合 */
export interface StreamCallbacks {
  /** 收到增量文本时调用 */
  onDelta: (delta: string) => void
  /** 流式结束（正常）时调用 */
  onDone: (fullText: string) => void
  /** 发生错误时调用 */
  onError: (err: Error) => void
  /** 收到 token 用量统计时调用（OpenAI 最后一帧 usage / Anthropic message_delta usage） */
  onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void
}

/** 中止信号（由外部 AbortController 提供） */
export interface StreamOptions {
  signal?: AbortSignal
}

/** 测试连通性结果 */
export interface TestResult {
  ok: boolean
  message: string
  latencyMs?: number
}

/** 将内部 ChatMessage 转换为 OpenAI 消息格式 */
function toOpenAIMessages(messages: ChatMessage[]): Array<{ role: string; content: string }> {
  return messages.map((m) => ({ role: m.role, content: m.content }))
}

/**
 * 规范化 API 端点 URL（智能补全协议与路径）：
 *
 * 补全规则：
 *   1. 协议：缺省 https://（支持用户只输入 `api.openai.com` 或 `api.openai.com/v1` 等）
 *   2. 末尾斜杠：统一去除
 *   3. 路径：根据目标类型补全
 *      - target='chat'   → openai/custom: /v1/chat/completions；anthropic: /v1/messages
 *      - target='models' → /v1/models
 *
 * 自动校正示例（以 chat 为例，输入 → 输出）：
 *   api.openai.com                              → https://api.openai.com/v1/chat/completions
 *   api.openai.com/                             → https://api.openai.com/v1/chat/completions
 *   http://api.openai.com                        → http://api.openai.com/v1/chat/completions
 *   https://api.openai.com/v1                   → https://api.openai.com/v1/chat/completions
 *   https://api.openai.com/v1/                  → https://api.openai.com/v1/chat/completions
 *   https://api.openai.com/v1/chat/completions  → 不变
 *   https://api.openai.com/v1/models           → https://api.openai.com/v1/chat/completions (截断后补全)
 *
 * @param rawEndpoint 用户输入的原始端点
 * @param target 目标类型：'chat'（聊天请求）或 'models'（模型列表查询）
 * @param protocol 协议类型：影响 chat 路径
 */
function normalizeApiUrl(
  rawEndpoint: string,
  target: 'chat' | 'models',
  protocol: 'openai' | 'anthropic' | 'custom',
): string {
  let url = rawEndpoint.trim()
  if (!url) return url

  // 1. 补全协议：缺省 https://
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url
  }

  // 2. 去除末尾斜杠
  url = url.replace(/\/+$/, '')

  // 3. 根据目标类型补全路径
  if (target === 'models') {
    // 目标：GET /v1/models
    if (url.endsWith('/v1/models')) {
      // 已完整
    } else if (url.endsWith('/v1')) {
      url = url + '/models'
    } else if (url.endsWith('/models')) {
      // 已是 /models 末尾（非 /v1/models），保持原样
    } else if (url.includes('/v1/')) {
      // 已包含 /v1/ 路径（如 /v1/chat/completions），截断到 /v1 后追加 /models
      const v1Idx = url.indexOf('/v1/')
      url = url.slice(0, v1Idx + 3) + '/models'
    } else {
      // 无 /v1 路径，追加 /v1/models
      url = url + '/v1/models'
    }
  } else {
    // target === 'chat'
    if (protocol === 'anthropic') {
      // 目标：POST /v1/messages
      if (url.endsWith('/v1/messages')) {
        // 已完整
      } else if (url.endsWith('/v1')) {
        url = url + '/messages'
      } else if (url.includes('/v1/')) {
        // 截断到 /v1 后追加 /messages
        const v1Idx = url.indexOf('/v1/')
        url = url.slice(0, v1Idx + 3) + '/messages'
      } else {
        url = url + '/v1/messages'
      }
    } else {
      // openai / custom，目标：POST /v1/chat/completions
      if (url.endsWith('/chat/completions')) {
        // 已完整
      } else if (url.endsWith('/v1')) {
        url = url + '/chat/completions'
      } else if (url.includes('/v1/')) {
        // 已包含 /v1/ 路径（如 /v1/models），截断到 /v1 后追加 /chat/completions
        const v1Idx = url.indexOf('/v1/')
        url = url.slice(0, v1Idx + 3) + '/chat/completions'
      } else {
        url = url + '/v1/chat/completions'
      }
    }
  }

  return url
}

/**
 * 智能补全 API endpoint（聊天请求用）：
 * - OpenAI 兼容协议：补全到 /v1/chat/completions
 * - Anthropic 协议：补全到 /v1/messages
 */
function resolveEndpoint(provider: CustomAIProvider): string {
  return normalizeApiUrl(provider.apiEndpoint, 'chat', provider.protocol)
}

/** 将内部 ChatMessage 转换为 Anthropic 消息格式（system 单独传，user/assistant 入 messages） */
function toAnthropicPayload(
  messages: ChatMessage[],
  model: string,
  maxTokens?: number,
  temperature?: number,
): {
  system?: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  model: string
  max_tokens: number
  temperature?: number
  stream: boolean
} {
  const system = messages.find((m) => m.role === 'system')?.content
  const convo = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  return {
    ...(system ? { system } : {}),
    messages: convo,
    model,
    max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(temperature !== undefined ? { temperature } : {}),
    stream: true,
  }
}

/**
 * 流式调用 OpenAI 兼容 API
 *
 * @param provider Provider 配置
 * @param messages 历史消息（含本次 user 消息）
 * @param callbacks 流式回调
 * @param options 中止信号等
 */
export async function streamChat(
  provider: CustomAIProvider,
  messages: ChatMessage[],
  callbacks: StreamCallbacks,
  options: StreamOptions = {},
): Promise<void> {
  const { onDelta, onDone, onError, onUsage } = callbacks
  let fullText = ''
  // token 用量（流式过程中累积，onDone 前回调）
  let promptTokens = 0
  let completionTokens = 0
  let usageReported = false
  const reportUsage = () => {
    if (usageReported) return
    if (!onUsage) return
    if (promptTokens === 0 && completionTokens === 0) return
    usageReported = true
    onUsage({ promptTokens, completionTokens })
  }

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    }
    let body: string
    const url = resolveEndpoint(provider)

    if (provider.protocol === 'anthropic') {
      headers['x-api-key'] = provider.apiKey
      headers['anthropic-version'] = '2023-06-01'
      body = JSON.stringify(
        toAnthropicPayload(
          messages,
          provider.model,
          provider.maxTokens,
          provider.temperature,
        ),
      )
    } else {
      // openai / custom
      headers.Authorization = `Bearer ${provider.apiKey}`
      const payload: Record<string, unknown> = {
        model: provider.model,
        messages: toOpenAIMessages(messages),
        stream: true,
        // 请求流式最后一帧返回 usage 统计
        stream_options: { include_usage: true },
      }
      if (provider.temperature !== undefined) payload.temperature = provider.temperature
      if (provider.maxTokens !== undefined) payload.max_tokens = provider.maxTokens
      body = JSON.stringify(payload)
    }

    console.log(
      `[ai-client] 流式请求: protocol=${provider.protocol} model=${provider.model} url=${url}`,
    )

    const response = await request(url, {
      method: 'POST',
      headers,
      body,
      signal: options.signal,
    })

    if (response.statusCode < 200 || response.statusCode >= 300) {
      const errText = await response.body.text()
      throw new Error(
        `API 返回错误状态 ${response.statusCode}: ${errText.slice(0, ERROR_LOG_MAX_LEN)}`,
      )
    }

    // 手动解析 SSE 流：按行读取，data: 前缀的行是 JSON
    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true })

      // 按行分割处理
      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim()
        buffer = buffer.slice(newlineIdx + 1)

        if (!line) continue
        if (line.startsWith(':')) continue // SSE 注释行

        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') {
          reportUsage()
          onDone(fullText)
          return
        }

        try {
          const json = JSON.parse(data)
          if (provider.protocol === 'anthropic') {
            // Anthropic 流式事件格式
            if (json.type === 'content_block_delta' && json.delta?.text) {
              fullText += json.delta.text
              onDelta(json.delta.text)
            } else if (json.type === 'message_start' && json.message?.usage) {
              // 输入 token 用量
              promptTokens = json.message.usage.input_tokens || 0
            } else if (json.type === 'message_delta' && json.usage) {
              // 输出 token 用量（累积）
              completionTokens = json.usage.output_tokens || 0
            } else if (json.type === 'message_stop') {
              reportUsage()
              onDone(fullText)
              return
            } else if (json.type === 'error') {
              throw new Error(json.error?.message || 'Anthropic 流式错误')
            }
          } else {
            // OpenAI 流式格式
            const delta = json.choices?.[0]?.delta?.content
            if (delta) {
              fullText += delta
              onDelta(delta)
            }
            // usage（流式最后一帧携带，需 stream_options.include_usage:true）
            if (json.usage) {
              promptTokens = json.usage.prompt_tokens || promptTokens
              completionTokens = json.usage.completion_tokens || completionTokens
            }
            // finish_reason 存在表示结束（部分兼容服务不发 [DONE]）
            if (json.choices?.[0]?.finish_reason) {
              reportUsage()
              onDone(fullText)
              return
            }
          }
        } catch (parseErr) {
          // 单行 JSON 解析失败不应中断流，记录后跳过
          console.warn('[ai-client] SSE 行解析失败:', parseErr, 'line:', data.slice(0, ERROR_LOG_MAX_LEN_SHORT))
        }
      }
    }

    // 流自然结束（未收到 [DONE] / message_stop）
    reportUsage()
    onDone(fullText)
  } catch (err) {
    // AbortError 视为正常取消
    if (err instanceof Error && err.name === 'AbortError') {
      console.log('[ai-client] 流式请求被取消')
      reportUsage()
      onDone(fullText)
      return
    }
    onError(err instanceof Error ? err : new Error(String(err)))
  }
}

/**
 * 测试 Provider 连通性
 *
 * 发送一个极简的非流式请求（max_tokens=1），仅验证 endpoint 可达 + apiKey 有效。
 */
export async function testProvider(provider: CustomAIProvider): Promise<TestResult> {
  const start = Date.now()
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
    let body: string
    const url = resolveEndpoint(provider)

    if (provider.protocol === 'anthropic') {
      headers['x-api-key'] = provider.apiKey
      headers['anthropic-version'] = '2023-06-01'
      body = JSON.stringify({
        model: provider.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      })
    } else {
      headers.Authorization = `Bearer ${provider.apiKey}`
      body = JSON.stringify({
        model: provider.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
      })
    }

    const response = await request(url, {
      method: 'POST',
      headers,
      body,
      headersTimeout: PROVIDER_TEST_TIMEOUT_MS,
      bodyTimeout: PROVIDER_TEST_TIMEOUT_MS,
    })
    const latencyMs = Date.now() - start

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return { ok: true, message: '连通性测试成功', latencyMs }
    }
    const errText = await response.body.text()
    return {
      ok: false,
      message: `HTTP ${response.statusCode}: ${errText.slice(0, 200)}`,
      latencyMs,
    }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - start,
    }
  }
}

/**
 * 需求 9：列出 Provider 可用模型（OpenAI 兼容 /v1/models 接口）
 *
 * GET `${endpoint 智能补全 /v1/models}` with Authorization: Bearer ${apiKey}
 * 解析 OpenAI 兼容格式 `{ data: [{ id: 'gpt-4' }, ...] }`
 * Anthropic 协议无对应接口，返回空数组
 *
 * 错误处理：失败时抛错（由调用方 catch 并展示具体原因），区分：
 *   - 401/403：API Key 缺失或无效（多数主流端点 /v1/models 需要鉴权）
 *   - 其他 HTTP 错误：返回状态码 + 响应体片段
 *   - 网络异常：返回原始错误信息
 *
 * @param input Provider 输入（不需要 id/时间戳）
 */
export async function listModels(input: CustomAIProviderInput): Promise<string[]> {
  // Anthropic 协议无 /v1/models 接口
  if (input.protocol === 'anthropic') return []

  // 智能补全协议与路径（支持只输入域名、缺 https://、末尾斜杠等场景）
  const url = normalizeApiUrl(input.apiEndpoint, 'models', input.protocol)

  const headers: Record<string, string> = {
    Accept: 'application/json',
  }
  // API Key 可选：有些公开端点不需要鉴权即可列出模型；但 OpenAI/DeepSeek/Qwen 等需要
  if (input.apiKey.trim()) {
    headers.Authorization = `Bearer ${input.apiKey}`
  }

  let response
  try {
    response = await request(url, {
      method: 'GET',
      headers,
      headersTimeout: PROVIDER_TEST_TIMEOUT_MS,
      bodyTimeout: PROVIDER_TEST_TIMEOUT_MS,
    })
  } catch (err) {
    throw new Error(`请求失败：${err instanceof Error ? err.message : String(err)}`)
  }

  // 401/403：API Key 缺失或无效
  if (response.statusCode === 401 || response.statusCode === 403) {
    const errText = await response.body.text().catch(() => '')
    throw new Error(
      `API Key 缺失或无效（HTTP ${response.statusCode}），该端点需要有效的 API Key 才能查询模型列表${
        errText ? `：${errText.slice(0, 120)}` : ''
      }`,
    )
  }

  // 其他非 2xx 错误
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const errText = await response.body.text().catch(() => '')
    throw new Error(
      `HTTP ${response.statusCode}${errText ? `：${errText.slice(0, 120)}` : ''}`,
    )
  }

  // 解析响应体
  let body: { data?: Array<{ id?: string }> }
  try {
    body = await response.body.json() as { data?: Array<{ id?: string }> }
  } catch {
    // 部分端点返回非 JSON 格式（如 HTML 错误页）
    throw new Error('响应格式异常（非 JSON），该端点可能不支持 /v1/models')
  }

  if (!body.data || !Array.isArray(body.data)) {
    // 响应是 JSON 但不是 OpenAI 兼容格式
    throw new Error('响应格式不是 OpenAI 兼容的 { data: [...] } 结构')
  }

  const models = body.data
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .sort((a, b) => a.localeCompare(b))

  console.log(`[ai-client] listModels: ${url} 返回 ${models.length} 个模型`)
  return models
}
