import { expect, it } from 'vitest'
import { CompletionPending } from '../../installer-shared/presentation/finalize'
import { completionErrorText } from './completion-error'

it.each([new Error('无法核对已有程序的启动身份'), '无法核对已有程序的启动身份'])('preserves native error details and recovery actions', detail => {
  const text = completionErrorText(new CompletionPending('close', detail))
  expect(text).toContain('安装已完成')
  expect(text).toContain('无法核对已有程序的启动身份')
  expect(text).toContain('可重试打开程序')
})

it('retains authorization cancellation instead of hiding it behind success', () => {
  expect(completionErrorText(new CompletionPending('close', '已取消：未授予管理员权限'))).toContain('已取消：未授予管理员权限')
})

it('distinguishes a busy maintenance admission from an application launch', () => {
  expect(completionErrorText(new CompletionPending('admission'))).toContain('当前维护操作')
})
