import type { UninstallResult } from './protocol'

export function uninstallFailureMessage(result: UninstallResult): string {
  const phase = result.error?.phase ?? result.phase
  const beforeRemoval = ['accepted', 'scanning', 'validating', 'stopping', 'backingUp'].includes(phase)
  const uncertain = result.warnings.some(value => value.startsWith('PARTIALLY_REMOVED:') || value.startsWith('WORKER_DID_NOT_CONFIRM_COMPLETION:'))
  return beforeRemoval && !uncertain && result.removedInstallPaths.length === 0 && result.removedDataRoots.length === 0
    ? '卸载在删除前中止，安装文件和用户数据尚未删除。'
    : '部分操作可能已完成，请按结果检查残留路径。'
}
