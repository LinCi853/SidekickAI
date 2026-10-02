import type { AssetSettings } from './ai-assets.types.js'
import { normalizeAccelerator } from './system-hotkeys.js'
export const DEFAULT_ASSET_SETTINGS: AssetSettings = {
  sort: 'recent', expandReasoning: false, revisionDisplay: 'history',
  localShortcuts: { search: 'Ctrl+F', conversations: 'Ctrl+1', prompts: 'Ctrl+2', files: 'Ctrl+3', freeze: 'Alt+P', previousBranch: 'Alt+Left', nextBranch: 'Alt+Right' },
}
export const ASSET_SHORTCUT_LABELS: Record<keyof AssetSettings['localShortcuts'], string> = {
  search: '搜索资产', conversations: '切到对话', prompts: '切到提示词', files: '切到资料', freeze: '页面冻结控制', previousBranch: '上一个分支', nextBranch: '下一个分支',
}
export function normalizeAssetAccelerator(value: string): string {
  return normalizeAccelerator(value.replace(/(?:CommandOrControl|Control)(?=\+)/gi, 'Ctrl')
    .replace(/(?:Super|Command)(?=\+)/gi, 'Meta'))
}
export function validateAssetAccelerator(value: string): void {
  if (typeof value !== 'string' || value.length > 80 || (value && !/^(?:(?:Ctrl|Control|Alt|Shift|Meta|Super|CommandOrControl|Command)\+)+(?:[A-Za-z0-9]|F\d{1,2}|Left|Right|Up|Down|Space|Enter|Tab|Escape|Home|End|PageUp|PageDown)$/i.test(value))) throw new Error('请输入带修饰键的快捷键组合')
  const key = normalizeAssetAccelerator(value)
  if (['ctrl+w', 'alt+f4', 'ctrl+s', 'ctrl+c', 'ctrl+v', 'ctrl+x', 'ctrl+z', 'ctrl+a', 'alt+tab'].includes(key)) throw new Error('此组合用于编辑或关闭窗口，请选择其他快捷键')
}
export function mergeAssetSettings(current: AssetSettings, changes: Partial<AssetSettings>): AssetSettings {
  const next = { ...current, ...changes, localShortcuts: { ...current.localShortcuts, ...changes.localShortcuts } }
  if (!['recent', 'views'].includes(next.sort) || typeof next.expandReasoning !== 'boolean' || !['history', 'diff'].includes(next.revisionDisplay)) throw new Error('资产设置无效')
  const used = new Set<string>()
  for (const name of Object.keys(DEFAULT_ASSET_SETTINGS.localShortcuts) as Array<keyof AssetSettings['localShortcuts']>) {
    const value = next.localShortcuts[name]
    validateAssetAccelerator(value)
    if (!value) continue
    const key = normalizeAssetAccelerator(value)
    if (used.has(key)) throw new Error('资产快捷键不能重复')
    used.add(key)
  }
  return { sort: next.sort, expandReasoning: next.expandReasoning, revisionDisplay: next.revisionDisplay, localShortcuts: next.localShortcuts }
}
