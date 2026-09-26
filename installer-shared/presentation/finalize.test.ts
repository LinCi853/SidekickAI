import { expect, it, vi } from 'vitest'
import { finalizeWizard } from './finalize'

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

it('surfaces a native refusal to close', async () => {
  await expect(finalizeWizard({ close: async () => false })).rejects.toThrow('当前操作仍在进行')
})
