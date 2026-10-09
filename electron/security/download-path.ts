import path from 'node:path'

export function safeDownloadFilename(value: string): string {
  const name = value.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 180).replace(/[.\s]+$/g, '') || 'download'
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `_${name}` : name
}

export function containedDownloadPath(directory: string, filename: string): string {
  const root = path.resolve(directory)
  const target = path.join(root, safeDownloadFilename(filename))
  const relative = path.relative(root, target)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Download target is outside the selected directory')
  return target
}
