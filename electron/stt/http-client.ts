// electron/stt/http-client.ts — AI 引擎 HTTP 传输

import { net } from 'electron'
import { ERROR_LOG_MAX_LEN } from './constants.js'

/**
 * 通过 Electron net.request 发送 JSON POST 请求，自动走应用代理
 * @param url 完整 URL
 * @param body JSON 字符串或 Buffer
 * @param apiKey 鉴权密钥
 * @param tag 日志标签
 * @returns 响应体字符串
 *
 * 关键修复：不要手动设置 Content-Length（会让 net.request 报 ERR_INVALID_ARGUMENT）。
 * net.request 会自行计算并切分 chunked encoding。
 */
export function httpPostJson(
  url: string,
  body: string | Buffer,
  apiKey: string,
  tag: string,
): Promise<string> {
  return new Promise((resolve) => {
    try {
      // 校验 URL 合法性（避免 net.request 报 ERR_INVALID_ARGUMENT）
      let safeUrl: string
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error(`不支持的协议: ${parsed.protocol}`)
        }
        safeUrl = parsed.toString()
      } catch (e) {
        console.error(`[SttEngine] ${tag} URL 非法: ${url}`, e)
        resolve('')
        return
      }

      const req = net.request({
        method: 'POST',
        url: safeUrl,
        redirect: 'follow',
      })
      req.setHeader('Content-Type', 'application/json')
      req.setHeader('Authorization', `Bearer ${apiKey}`)
      // 关键：不要设置 Content-Length！让 net.request 自动计算
      // 手动设置后一旦与实际写入字节数有差异，Chromium 会抛 ERR_INVALID_ARGUMENT
      sendHttpRequest(req, body, tag, resolve)
    } catch (e) {
      console.error(`[SttEngine] ${tag} 请求构造失败:`, e)
      resolve('')
    }
  })
}

/**
 * 通过 Electron net.request 发送 multipart/form-data POST 请求
 */
export function httpPostMultipart(
  url: string,
  body: Buffer,
  boundary: string,
  apiKey: string,
  tag: string,
): Promise<string> {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`不支持的协议: ${parsed.protocol}`)
      }
      const safeUrl = parsed.toString()

      const req = net.request({
        method: 'POST',
        url: safeUrl,
        redirect: 'follow',
      })
      req.setHeader('Content-Type', `multipart/form-data; boundary=${boundary}`)
      req.setHeader('Authorization', `Bearer ${apiKey}`)
      // 同样不设置 Content-Length
      sendHttpRequest(req, body, tag, resolve)
    } catch (e) {
      console.error(`[SttEngine] ${tag} 请求构造失败:`, e)
      resolve('')
    }
  })
}

/**
 * 通用 net.request 发送 + 接收 + 超时
 * 关键修复：body 统一转为 Buffer 后再写入，避免字符串编码歧义导致的 ERR_INVALID_ARGUMENT
 */
function sendHttpRequest(
  req: Electron.ClientRequest,
  body: string | Buffer,
  tag: string,
  resolve: (value: string) => void,
): void {
  const TIMEOUT_MS = 30000
  let timer: NodeJS.Timeout | null = null
  let settled = false
  const finish = (value: string) => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    try { req.abort() } catch { /* ignore */ }
    resolve(value)
  }

  timer = setTimeout(() => {
    console.error(`[SttEngine] ${tag} 请求超时 (${TIMEOUT_MS}ms)`)
    finish('')
  }, TIMEOUT_MS)

  req.on('response', (res) => {
    const statusCode = res.statusCode
    const chunks: Buffer[] = []
    res.on('data', (chunk: Buffer) => chunks.push(chunk))
    res.on('end', () => {
      const data = Buffer.concat(chunks).toString('utf8')
      if (statusCode !== 200) {
        console.error(
          `[SttEngine] ${tag} 返回 ${statusCode}: ${data.slice(0, ERROR_LOG_MAX_LEN)}`,
        )
        finish('')
        return
      }
      finish(data)
    })
    res.on('error', (err: Error) => {
      console.error(`[SttEngine] ${tag} 响应流错误:`, err.message)
      finish('')
    })
  })

  req.on('error', (err: Error) => {
    // 记录详细错误便于诊断 ERR_INVALID_ARGUMENT 等问题
    console.error(`[SttEngine] ${tag} 请求失败: ${err.message} (code: ${(err as any).code ?? 'unknown'})`)
    finish('')
  })

  try {
    // 统一转为 Buffer：避免 string 编码歧义（不同编码模式下字节数差异会触发 ERR_INVALID_ARGUMENT）
    const bodyBuf = typeof body === 'string' ? Buffer.from(body, 'utf-8') : body
    // 调试日志：输出 body 大小和 base64 data URL 长度，便于排查超长请求
    if (process.env.NODE_ENV !== 'production' || process.env.VOICE_DEBUG) {
      const dataUrlMatch = typeof body === 'string' ? body.match(/data:audio\/wav;base64,([^"]*)/) : null
      if (dataUrlMatch) {
        console.log(`[SttEngine] ${tag} 发送请求: url=${req}, body 总长=${bodyBuf.length} 字节, base64 音频长度=${dataUrlMatch[1].length}`)
      } else {
        console.log(`[SttEngine] ${tag} 发送请求: body 总长=${bodyBuf.length} 字节`)
      }
    }
    req.write(bodyBuf)
    req.end()
  } catch (e) {
    console.error(`[SttEngine] ${tag} 写入请求体失败:`, e)
    finish('')
  }
}
