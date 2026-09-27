import type { DataRoot, UninstallScanResponse } from './protocol'

export function describeDataScope(scan: UninstallScanResponse | null, selectedTokens: string[]): { roots: DataRoot[]; issue: string | null } {
  const selected = new Set(selectedTokens)
  const roots = scan?.dataRoots.filter(root => root.associatedTargetIds.some(id => selected.has(id.token))) ?? []
  for (const root of roots) {
    if (!root.removable) {
      return { roots, issue: `无法确认用户数据的归属或安全性：${root.path}。请在原登录账户下直接打开卸载器并重新扫描；也可选择保留用户数据。` }
    }
    const unselected = root.associatedTargetIds.filter(id => !selected.has(id.token))
    if (unselected.length) {
      const paths = unselected.map(id => {
        const location = scan?.locations.find(item => item.id.token === id.token)
        return location?.displayPath || location?.path || '未知安装位置'
      })
      return { roots, issue: `用户数据 ${root.path} 仍被未选中的安装使用：${paths.join('、')}。请选择保留用户数据，或返回选择需要同时卸载的安装。` }
    }
  }
  return { roots, issue: null }
}
