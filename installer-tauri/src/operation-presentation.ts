import { compareResourceVersions } from '../../installer-shared/resource-package-versions.mjs'
import type { InstallMode } from './global'

export function directoryForScope(current: string, previousSuggestion: string, nextSuggestion: string): string {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return !current || normalize(current) === normalize(previousSuggestion) ? nextSuggestion : current
}

export function operationName(mode: InstallMode, installedVersion?: string, incomingVersion?: string): string {
  if (mode === 'uninstall') return '卸载'
  if (installedVersion && incomingVersion) {
    try {
      const order = compareResourceVersions(incomingVersion, installedVersion)
      if (order > 0) return '升级'
      if (order < 0) return '版本回退'
    } catch { /* Unknown versions keep the selected operation label. */ }
  }
  return mode === 'repair' ? '修复' : '安装'
}

export function visibleLogLines(text: string): string[] {
  const labels: Record<string, string> = { I: '信息', S: '状态', W: '警告', E: '错误' }
  return text.split(/\r?\n/).filter(line => line && !line.startsWith('P|')).map(line => {
    const separator = line.indexOf('|')
    return separator === 1 && labels[line[0]] ? `${labels[line[0]]} · ${line.slice(2)}` : line
  })
}
