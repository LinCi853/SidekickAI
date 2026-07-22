// electron/utils/file-drop-handler.ts — 文件拖拽导入：读取文件字节并以 data URL 形式返回
//
// 用于跨 webview 边界传递文件内容：
//   1. 父渲染层 document 监听 drop 事件，从 e.dataTransfer.files 取真实路径（Electron 特性）
//   2. 经 IPC WEBVIEW_FILE_DROP 把路径送到主进程
//   3. 本模块读取文件字节，返回 data URL 数组
//   4. 渲染层 webview.executeJavaScript 注入脚本，在 guest 内构造 File 对象并派发合成事件
//
// data URL 方案的取舍：
//   - 优点：跨 webview 边界传递最简单（无需注册自定义协议、无需禁用 webSecurity）
//   - 缺点：base64 编码体积膨胀 ~33%，大文件（>100MB）会占用较多内存与 IPC 带宽
//   - 对于 AI 应用的文件导入场景（图片、文档、代码片段），通常 <50MB，data URL 方案足够
//   - 若未来需要支持超大文件，可改为注册自定义协议 + 流式读取

import fs from 'fs'
import path from 'path'

/** 拖拽文件读取结果 */
export interface DroppedFile {
  /** 文件名（含扩展名，不含路径） */
  filename: string
  /** data URL：`data:<mime>;base64,<...>` */
  dataUrl: string
  /** MIME 类型（基于扩展名推断，未知类型回退到 application/octet-stream） */
  mime: string
  /** 文件字节数 */
  size: number
}

/**
 * 读取文件并以 data URL 形式返回。
 * 单个文件读取失败不影响其他文件，仅跳过并打印警告。
 *
 * @param filePaths 文件绝对路径数组
 * @returns 成功读取的文件信息数组（顺序与输入一致，跳过失败的）
 */
export async function readFilesAsDataUrls(filePaths: string[]): Promise<DroppedFile[]> {
  const results: DroppedFile[] = []
  for (const p of filePaths) {
    try {
      const buf = await fs.promises.readFile(p)
      const ext = path.extname(p).slice(1).toLowerCase()
      const mime = guessMime(ext)
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`
      results.push({
        filename: path.basename(p),
        dataUrl,
        mime,
        size: buf.length,
      })
    } catch (e) {
      console.warn('[file-drop-handler] 读取文件失败:', p, e)
    }
  }
  return results
}

/**
 * 基于扩展名推断 MIME 类型。
 * 仅覆盖 AI 应用文件导入常见的类型，未知扩展名回退到 application/octet-stream。
 */
function guessMime(ext: string): string {
  const map: Record<string, string> = {
    // 图片
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    // 文档
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    html: 'text/html',
    htm: 'text/html',
    xml: 'application/xml',
    json: 'application/json',
    // 代码
    js: 'text/javascript',
    mjs: 'text/javascript',
    ts: 'text/typescript',
    tsx: 'text/typescript',
    jsx: 'text/javascript',
    py: 'text/x-python',
    java: 'text/x-java',
    c: 'text/x-c',
    cpp: 'text/x-c++',
    h: 'text/x-c',
    hpp: 'text/x-c++',
    cs: 'text/x-csharp',
    go: 'text/x-go',
    rs: 'text/x-rust',
    rb: 'text/x-ruby',
    php: 'application/x-php',
    sh: 'application/x-sh',
    bash: 'application/x-sh',
    yml: 'text/yaml',
    yaml: 'text/yaml',
    toml: 'application/toml',
    ini: 'text/plain',
    cfg: 'text/plain',
    css: 'text/css',
    scss: 'text/x-scss',
    // Office
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    // 压缩
    zip: 'application/zip',
    gz: 'application/gzip',
    tar: 'application/x-tar',
    '7z': 'application/x-7z-compressed',
    rar: 'application/x-rar-compressed',
    // 音视频
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    mp4: 'video/mp4',
    webm: 'video/webm',
    // 数据
    sql: 'application/sql',
  }
  return map[ext] || 'application/octet-stream'
}
