// electron/utils/downloader.ts — 文件下载工具
//
// 提供：
//   - downloadFile：流式下载文件（自动跟随 3xx 重定向），使用 Electron net 模块
//   - downloadWithMirrors：带镜像 fallback 的下载，依次尝试 URL 列表
//
// 从 electron/ipc/voice-ipc.ts 抽离，保持函数实现细节不变。

import { net } from 'electron'
import * as fs from 'fs'

/**
 * 流式下载文件（自动跟随 3xx 重定向）。
 * 使用 Electron net 模块，自动遵循应用 session 的代理配置（system/custom/direct）。
 * 国内访问 HuggingFace / GitHub 常被墙，主 URL 失败时自动尝试镜像。
 * 超时设计：连接超时 30s + 数据流停滞超时 30s（收到 headers 后仍保护 body 传输）
 */
export function downloadFile(
  url: string,
  dest: string,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = net.request(url)
    let connectTimer: NodeJS.Timeout | null = null
    let stallTimer: NodeJS.Timeout | null = null

    const clearAllTimers = () => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null }
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = null }
    }
    const abortAll = (msg: string) => {
      clearAllTimers()
      try { req.abort() } catch (e: unknown) { console.warn('[voice-ipc] 中止下载请求失败:', e) }
      reject(new Error(msg))
    }

    // 连接超时：30s 内未收到 response headers 则放弃
    connectTimer = setTimeout(() => abortAll('下载超时（30s 无响应）'), 30000)

    // 停滞超时重置：每次收到 data 都重置 30s 计时器
    const resetStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => abortAll('下载超时（30s 数据停滞）'), 30000)
    }

    req.on('response', (res) => {
      // 连接已建立，清除连接超时
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null }
      const statusCode = res.statusCode
      // 跟随重定向
      if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
        ;(res as unknown as NodeJS.ReadableStream).resume()
        const nextUrl = Array.isArray(res.headers.location)
          ? res.headers.location[0]
          : res.headers.location
        downloadFile(nextUrl, dest, onProgress).then(resolve, reject)
        return
      }
      if (statusCode !== 200) {
        ;(res as unknown as NodeJS.ReadableStream).resume()
        reject(new Error(`HTTP ${statusCode}`))
        return
      }
      const totalHeader = res.headers['content-length']
      const total = parseInt(
        Array.isArray(totalHeader) ? totalHeader[0] || '0' : totalHeader || '0',
        10,
      )
      let received = 0
      const stream = fs.createWriteStream(dest)
      // 开始接收数据，启用停滞超时
      resetStallTimer()
      res.on('data', (chunk: Buffer) => {
        received += chunk.length
        resetStallTimer()
        if (total > 0) {
          onProgress(Math.min(99, Math.round((received / total) * 100)))
        }
      })
      ;(res as unknown as NodeJS.ReadableStream).pipe(stream)
      stream.on('finish', () => {
        clearAllTimers()
        stream.close(() => resolve())
      })
      stream.on('error', (err) => { clearAllTimers(); reject(err) })
      res.on('error', (err: Error) => { clearAllTimers(); reject(err) })
    })
    req.on('error', (err) => {
      clearAllTimers()
      reject(err)
    })
    req.end()
  })
}

/**
 * 带镜像 fallback 的下载：依次尝试 URL 列表，任一成功即返回。
 * 最后将实际错误信息汇总，便于定位问题。
 */
export async function downloadWithMirrors(
  urls: string[],
  dest: string,
  onProgress: (percent: number) => void,
): Promise<void> {
  const errors: string[] = []
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]
    console.log(`[voice-download] 尝试下载 (${i + 1}/${urls.length}):`, url)
    onProgress(0)
    try {
      await downloadFile(url, dest, onProgress)
      console.log(`[voice-download] 下载成功:`, url)
      return
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`[voice-download] 下载失败 (${i + 1}/${urls.length}):`, url, '→', msg)
      errors.push(`${url}: ${msg}`)
      // 删除可能残留的不完整文件
      try { fs.unlinkSync(dest) } catch (unlinkErr: unknown) { console.warn('[voice-ipc] 删除残留文件失败:', unlinkErr) }
    }
  }
  throw new Error('全部下载源失败：' + errors.join(' | '))
}
