// electron/utils/pdf-protocol.ts — 打印预览 PDF 自定义协议
//
// 打印预览标签页用 iframe 展示 printToPDF 生成的临时 PDF。
// 直接 iframe 加载 file:// 在 dev 模式（页面为 http://）会被 Chromium
// webSecurity 阻止；自定义协议 sidekick-pdf:// 无此限制（注册为特权协议）。
//
// URL 格式：sidekick-pdf://preview/<encodeURIComponent(绝对路径)>
// 临时文件不做自动清理（React StrictMode 双挂载会误删），仅在
// 「另存为 PDF」成功复制后由渲染层显式清理。

import { protocol } from 'electron'
import fs from 'fs'

export const PDF_SCHEME = 'sidekick-pdf'

/** 将临时 PDF 绝对路径转为 sidekick-pdf:// URL（供 iframe 加载） */
export function toPdfProtocolUrl(filePath: string): string {
  const encoded = encodeURIComponent(filePath)
  return `${PDF_SCHEME}://preview/${encoded}`
}

/**
 * 注册打印预览 PDF 自定义协议处理器。
 * 必须在 app.whenReady() 后调用（protocol.handle 要求）。
 * registerSchemesAsPrivileged 已在 main.ts 顶层调用。
 */
export function registerPdfProtocol(): void {
  console.log('[pdf-protocol] 注册自定义协议:', PDF_SCHEME)
  protocol.handle(PDF_SCHEME, (request) => {
    try {
      const url = new URL(request.url)
      const encoded = url.pathname.replace(/^\//, '')
      if (!encoded) return new Response('Not found', { status: 404 })
      const filePath = decodeURIComponent(encoded)
      if (!fs.existsSync(filePath)) {
        console.error('[pdf-protocol] 文件不存在:', filePath)
        return new Response('Not found', { status: 404 })
      }
      const buf = fs.readFileSync(filePath)
      return new Response(buf, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'inline; filename="preview.pdf"',
        },
      })
    } catch (err) {
      console.error('[pdf-protocol] 协议处理失败:', err)
      return new Response('Internal error', { status: 500 })
    }
  })
}
