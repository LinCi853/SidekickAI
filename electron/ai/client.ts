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
 * 智能补全 API endpoint：
 * - OpenAI 兼容协议：如果 URL 不以 /chat/completions 结尾，自动补上
 * - Anthropic 协议：如果 URL 不以 /v1/messages 结尾，自动补上
 */
function resolveEndpoint(provider: CustomAIProvider): string {
  let url = provider.apiEndpoint.trim()
  // 去掉末尾斜杠
  url = url.replace(/\/+$/, '')

  if (provider.protocol === 'anthropic') {
    if (!url.endsWith('/v1/messages')) {
      // 如果已经有 /v1 前缀，补 /messages；否则补 /v1/messages
      if (url.endsWith('/v1')) {
        url = url + '/messages'
      } else {
        url = url + '/v1/messages'
      }
    }
  } else {
    // openai / custom 协议
    if (!url.endsWith('/chat/completions')) {
      if (url.endsWith('/v1')) {
        url = url + '/chat/completions'
      } else if (!url.includes('/v1/')) {
        url = url + '/v1/chat/completions'
      } else {
        url = url + '/chat/completions'
      }
    }
  }
  return url
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
 * 失败时返回空数组（不抛错），由调用方决定如何处理
 *
 * @param input Provider 输入（不需要 id/时间戳）
 */
export async function listModels(input: CustomAIProviderInput): Promise<string[]> {
  // Anthropic 协议无 /v1/models 接口
  if (input.protocol === 'anthropic') return []

  try {
    let url = input.apiEndpoint.trim().replace(/\/+$/, '')
    // 智能补全 /v1/models
    if (url.endsWith('/v1')) {
      url = url + '/models'
    } else if (!url.includes('/v1/')) {
      url = url + '/v1/models'
    } else if (!url.endsWith('/models')) {
      // 截断到 /v1/ 后追加 models
      const v1Idx = url.indexOf('/v1/')
      if (v1Idx !== -1) {
        url = url.slice(0, v1Idx + 3) + '/models'
      } else {
        url = url + '/models'
      }
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${input.apiKey}`,
    }

    const response = await request(url, {
      method: 'GET',
      headers,
      headersTimeout: PROVIDER_TEST_TIMEOUT_MS,
      bodyTimeout: PROVIDER_TEST_TIMEOUT_MS,
    })

    if (response.statusCode < 200 || response.statusCode >= 300) {
      console.warn(`[ai-client] listModels 失败: HTTP ${response.statusCode}`)
      return []
    }

    const body = await response.body.json() as { data?: Array<{ id?: string }> }
    if (!body.data || !Array.isArray(body.data)) {
      console.warn('[ai-client] listModels 响应格式异常:', body)
      return []
    }

    const models = body.data
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .sort((a, b) => a.localeCompare(b))

    console.log(`[ai-client] listModels: ${url} 返回 ${models.length} 个模型`)
    return models
  } catch (err) {
    console.warn('[ai-client] listModels 异常:', err instanceof Error ? err.message : String(err))
    return []
  }
}
