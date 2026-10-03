import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { applicationProcessScript } from '../packages/desktop-common/application-process'

afterEach(() => vi.restoreAllMocks())

it('rejects a missing packaged helper even when the launch directory has a helper', () => {
  const local = path.join(process.cwd(), 'resources/windows/application-process.ps1')
  const available = vi.spyOn(fs, 'existsSync').mockImplementation(file => file === local)
  expect(() => applicationProcessScript('E:/damaged/resources')).toThrow('Application process support is unavailable')
  expect(available).toHaveBeenCalledOnce()
  expect(available).toHaveBeenCalledWith(path.join('E:/damaged/resources', 'windows/application-process.ps1'))
})

it('resolves development support only when no resources directory is supplied', () => {
  const local = path.join(process.cwd(), 'resources/windows/application-process.ps1')
  vi.spyOn(fs, 'existsSync').mockImplementation(file => file === local)
  expect(applicationProcessScript()).toBe(local)
})

it('uses the exact supplied packaged helper', () => {
  const supplied = path.join('E:/installed/resources', 'windows/application-process.ps1')
  vi.spyOn(fs, 'existsSync').mockImplementation(file => file === supplied)
  expect(applicationProcessScript('E:/installed/resources')).toBe(supplied)
})
