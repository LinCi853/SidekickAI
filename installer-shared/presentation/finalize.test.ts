import { expect, it, vi } from 'vitest'
import { CompletionPending, completionLaunch, completionPendingText, finalizeWizard } from './finalize'

it('opens the application only for its explicit completion action', () => {
  expect(completionLaunch('close')).toBe(false)
  expect(completionLaunch('open')).toBe(true)
})

it('requires persisted settings before launch preparation and closure', async () => {
  const order: string[] = []
  await finalizeWizard({
    save: async () => { order.push('save'); return true },
    prepareLaunch: async () => { order.push('launch'); return true },
    close: async () => { order.push('close'); return true },
  })
  expect(order).toEqual(['save', 'launch', 'close'])
})

it.each([false, new Error('write refused')])('keeps the wizard open when persistence fails with %s', async result => {
  const prepareLaunch = vi.fn(), close = vi.fn()
  await expect(finalizeWizard({
    save: async () => { if (result instanceof Error) throw result; return result },
    prepareLaunch, close,
  })).rejects.toThrow()
  expect(prepareLaunch).not.toHaveBeenCalled()
  expect(close).not.toHaveBeenCalled()
})

it('retains an explicit pending stage for a native refusal to close', async () => {
  await expect(finalizeWizard({ close: async () => false })).rejects.toMatchObject({ stage: 'close' })
})

it('occupies completion across saving and opening, including a rejected launch', async () => {
  const order: string[] = []
  await expect(finalizeWizard({
    begin: async () => { order.push('begin'); return true },
    save: async () => { order.push('save') },
    prepareLaunch: async () => { order.push('launch'); throw new Error('Process inspection denied') },
    close: async () => { order.push('close') },
    release: async () => { order.push('release') },
  })).rejects.toMatchObject({ stage: 'launch', detail: expect.any(Error) })
  expect(order).toEqual(['begin', 'save', 'launch', 'release'])
})

it('never performs completion actions when its admission lost to switching', async () => {
  const save = vi.fn(), close = vi.fn(), release = vi.fn()
  await expect(finalizeWizard({ begin: async () => false, save, close, release })).rejects.toMatchObject({ stage: 'admission' })
  expect(save).not.toHaveBeenCalled()
  expect(close).not.toHaveBeenCalled()
  expect(release).not.toHaveBeenCalled()
})

it('describes pending opening without exposing translated backend failure text', () => {
  const text = completionPendingText(new CompletionPending('launch', new Error('无法核对已有程序的启动身份')))
  expect(text).toContain('安装已完成')
  expect(text).not.toContain('无法核对')
  expect(text).not.toContain('失败')
})
