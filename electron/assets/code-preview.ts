import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app, shell } from 'electron'
export function codePreviewDocument(content: string, language: 'html' | 'css' | 'javascript'): string {
  if (language === 'html') return content
  const body = '<main><h1>网页代码预览</h1><p>这是用于样式和脚本预览的本地页面。</p><div class="card"><h2>示例内容</h2><button>示例按钮</button><input placeholder="示例输入框"></div><div id="app"></div><div id="root"></div></main>'
  const script = language === 'css' ? `const style = document.createElement('style'); style.textContent = ${JSON.stringify(content)}; document.head.append(style);` : content
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>网页代码预览</title><body>${body}<script>${script.replace(/<\/script/gi, '<\\/script')}</script></body></html>`
}
export async function previewAssetCode(content: string, language: 'html' | 'css' | 'javascript'): Promise<{ ok: boolean; error?: string }> {
  if (typeof content !== 'string' || content.length > 5 * 1024 * 1024 || !['html', 'css', 'javascript'].includes(language)) return { ok: false, error: '代码类型或大小不支持预览' }
  try {
    const root = path.join(app.getPath('temp'), 'sidekickai-code-preview')
    await mkdir(root, { recursive: true })
    const directory = await mkdtemp(path.join(root, 'page-'))
    const file = path.join(directory, 'index.html')
    await writeFile(file, codePreviewDocument(content, language), 'utf8')
    const error = await shell.openPath(file)
    return error ? { ok: false, error } : { ok: true }
  } catch (error) { return { ok: false, error: String(error) } }
}
