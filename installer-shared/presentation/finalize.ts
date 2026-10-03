export interface Finalization {
  begin?: () => Promise<boolean | void>
  release?: () => Promise<unknown>
  save?: () => Promise<boolean | void>
  prepareLaunch?: () => Promise<boolean | void>
  close: () => Promise<boolean | void>
}

export type CompletionIntent = 'open' | 'close'

export type CompletionStage = 'admission' | 'save' | 'launch' | 'close'

export class CompletionPending extends Error {
  constructor(readonly stage: CompletionStage, readonly detail?: unknown) {
    super(stage === 'admission' ? '正在等待维护操作完成' : '安装已完成，正在等待完成操作')
  }
}

export function completionPendingText(error: unknown): string {
  if (error instanceof CompletionPending && error.stage === 'admission') return '正在等待当前维护操作完成，请稍候再继续。'
  if (error instanceof CompletionPending && error.stage === 'save') return '安装已完成，完成设置尚待写入。请重试完成，或关闭向导。'
  return '安装已完成。请继续打开本次安装的程序，或关闭向导。'
}

export function completionLaunch(intent: CompletionIntent): boolean {
  return intent === 'open'
}

export async function finalizeWizard(actions: Finalization): Promise<void> {
  const run = async (stage: CompletionStage, action?: () => Promise<boolean | void>) => {
    if (!action) return
    try {
      if (await action() === false) throw new CompletionPending(stage)
    } catch (error) {
      throw error instanceof CompletionPending ? error : new CompletionPending(stage, error)
    }
  }
  let admitted = false
  try {
    await run('admission', actions.begin)
    admitted = true
    await run('save', actions.save)
    await run('launch', actions.prepareLaunch)
    await run('close', actions.close)
  } finally {
    if (admitted && actions.release) await actions.release().catch(() => {})
  }
}
