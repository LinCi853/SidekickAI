import { CompletionPending, completionPendingText } from '../../installer-shared/presentation/finalize'

export function completionErrorText(error: unknown): string {
  if (error instanceof CompletionPending && error.stage !== 'admission') {
    const detail = error.detail instanceof Error ? error.detail.message : typeof error.detail === 'string' ? error.detail : ''
    if (detail) return `安装已完成。${detail.slice(0, 600)} 可重试打开程序，或关闭向导。`
  }
  return completionPendingText(error)
}
