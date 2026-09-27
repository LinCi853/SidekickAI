import { describe, expect, it } from 'vitest'
import { directoryForScope, operationName, visibleLogLines } from './operation-presentation'

describe('installer operation presentation', () => {
  it('changes only an unchanged directory suggestion when switching installation scope', () => {
    const user = 'C:\\Users\\Example\\AppData\\Local\\Programs\\SidekickAI'
    const machine = 'C:\\Program Files\\SidekickAI'
    expect(directoryForScope('', user, machine)).toBe(machine)
    expect(directoryForScope(user, user, machine)).toBe(machine)
    expect(directoryForScope(user.toUpperCase() + '\\', user, machine)).toBe(machine)
    expect(directoryForScope('E:\\My Tools\\工百窗', user, machine)).toBe('E:\\My Tools\\工百窗')
    expect(directoryForScope(machine, user, machine)).toBe(machine)
    expect(directoryForScope('E:/portable-but-not-the-default', user, machine)).toBe('E:/portable-but-not-the-default')
  })
  it('distinguishes a newer prerelease from repairing the same version', () => {
    expect(operationName('repair', '0.1.0-beta.1', '0.1.0-beta.2')).toBe('升级')
    expect(operationName('repair', '0.1.0-beta.2', '0.1.0-beta.2')).toBe('修复')
    expect(operationName('repair', '0.1.0-beta.10', '0.1.0-beta.2')).toBe('版本回退')
    expect(operationName('install', undefined, '0.1.0-beta.2')).toBe('安装')
    expect(operationName('repair', 'unknown', '0.1.0-beta.2')).toBe('修复')
    expect(operationName('uninstall', '0.1.0', '0.2.0')).toBe('卸载')
  })
  it('retains warnings and errors while keeping progress counters out of history', () => {
    expect(visibleLogLines('I|payload verified\nP|42\nW|backup retained\nE|copy denied\n')).toEqual([
      '信息 · payload verified', '警告 · backup retained', '错误 · copy denied',
    ])
  })
})
