import { expect, it } from 'vitest'
import type { UninstallResult } from './protocol'
import { uninstallFailureMessage } from './result-summary'

const result: UninstallResult = { requestId: 'request', operationId: 'operation', state: 'failed', phase: 'failed',
  targetIds: [], removedInstallPaths: [], removedDataRoots: [], warnings: [],
  error: { code: 'PROCESS_STOP_FAILED', message: 'failed', phase: 'stopping', retryable: true, operationId: 'operation' } }

it('reports that a process shutdown failure did not delete files or data', () => {
  expect(uninstallFailureMessage(result)).toContain('尚未删除')
})

it.each([
  { ...result, removedInstallPaths: ['C:/fixture'] },
  { ...result, warnings: ['PARTIALLY_REMOVED: C:/fixture'] },
  { ...result, warnings: ['WORKER_DID_NOT_CONFIRM_COMPLETION: C:/fixture'] },
  { ...result, error: { ...result.error!, phase: 'removingInstall' as const } },
])('keeps uncertain or partial deletion visible', value => {
  expect(uninstallFailureMessage(value)).toContain('部分操作可能已完成')
})
