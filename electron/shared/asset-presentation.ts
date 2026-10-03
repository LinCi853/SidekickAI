export function isAssetInterfaceImage(item: { direction: string; mimeType: string; sourceUrl?: string }): boolean {
  if (item.direction !== 'output' || !item.mimeType.startsWith('image/') || !item.sourceUrl) return false
  try {
    const url = new URL(item.sourceUrl)
    return url.hostname === 'cdn.deepseek.com' && url.pathname.startsWith('/site-icons/')
  } catch { return false }
}

export function cleanCapturedCodeToolbar(markdown: string): string {
  // Only complete toolbars outside a fence are recognizable without the original DOM.
  const lines = markdown.split('\n')
  let fence: { char: string; length: number } | undefined
  const output: string[] = []
  for (let index = 0; index < lines.length; index++) {
    if (!fence) {
      const header = lines.slice(index, index + 14).join('\n').match(/^([a-z][\w+#.-]{0,23})\s*复制\s*\n+下载\s*\n+运行\s*\n+(`{3,})\n/i)
      if (header) {
        output.push(header[2] + header[1])
        fence = { char: '`', length: header[2].length }
        index += header[0].split('\n').length - 2
        continue
      }
    }
    const delimiter = lines[index].match(/^\s{0,3}(`{3,}|~{3,})(.*)$/)
    if (delimiter) {
      if (!fence) fence = { char: delimiter[1][0], length: delimiter[1].length }
      else if (delimiter[1][0] === fence.char && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = undefined
    }
    output.push(lines[index])
  }
  return output.join('\n')
}
