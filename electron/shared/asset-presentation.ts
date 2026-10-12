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

/** 工具调用状态行（联网搜索的「N 个来源」等）是工具状态，不属于页面内容；代码围栏内不动 */
const toolCallLine = /^\s*\d+\s*个(?:来源|网页|搜索结果)\s*$/

export function stripToolCallLines(content: string): string {
  let fence: string | undefined
  const output: string[] = []
  for (const line of content.split('\n')) {
    const delimiter = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (delimiter) {
      if (!fence) fence = delimiter[1]
      else if (delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !line.slice(delimiter[0].length).trim()) fence = undefined
      output.push(line)
      continue
    }
    if (!fence && toolCallLine.test(line)) continue
    output.push(line)
  }
  return output.join('\n')
}

/** 收录文本的比较基准：去掉工具调用状态行并折叠空白，换行/空格抖动不构成差异 */
export function captureRevisionSignature(content: string): string {
  return stripToolCallLines(content).replace(/\s+/g, ' ').trim()
}

const noiseLine = /^\S{1,12}$/

/** 新文本是否只是去掉了旧文本开头的工具卡片残行（无空白的短 token 行，如搜索词） */
export function captureDroppedLeadingNoise(previous: string, next: string): boolean {
  const before = captureRevisionSignature(previous)
  const after = captureRevisionSignature(next)
  if (!after || !before.endsWith(after)) return false
  const extra = before.slice(0, before.length - after.length).replace(/\s+$/, '')
  const lines = extra.split(/\s+/).filter(Boolean)
  return lines.length > 0 && lines.every(line => noiseLine.test(line))
}

/** 两段收录文本的差异是否只是工具卡片残行的出现或清理 */
export function captureLeadingNoiseDifference(a: string, b: string): boolean {
  return captureDroppedLeadingNoise(a, b) || captureDroppedLeadingNoise(b, a)
}
