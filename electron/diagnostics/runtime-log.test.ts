import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRuntimeLog, redactDiagnostic } from './runtime-log'

let root: string
beforeEach(() => { fs.mkdirSync(path.resolve('build'), { recursive: true }); root = fs.mkdtempSync(path.resolve('build/runtime-log-test-')) })
afterEach(() => {
  if (path.dirname(root) !== path.resolve('build') || !path.basename(root).startsWith('runtime-log-test-')) throw new Error('Unexpected fixture root')
  fs.rmSync(root, { recursive: true, force: true })
})
describe('runtime diagnostics', () => {
  it('changes files on local midnight and size boundaries, retaining Unicode and errors', () => {
    let date = new Date(2026, 9, 3, 23, 59)
    const log = createRuntimeLog(root, { now: () => date, maxBytes: 140 })
    log.write('info', 'main', ['Unicode \u4e2d\u6587'])
    log.write('error', 'main', [new Error('Fixture error')])
    date = new Date(2026, 9, 4)
    log.write('info', 'main', ['New day'])
    date = new Date(2026, 9, 3, 23, 58)
    log.write('info', 'main', ['Clock moved back'])
    const names = fs.readdirSync(root)
    expect(names).toHaveLength(4)
    expect(names.filter(name => name.startsWith('2026-10-03'))).toHaveLength(3)
    expect(names.filter(name => name.startsWith('2026-10-04'))).toHaveLength(1)
    expect(names.flatMap(name => fs.readFileSync(path.join(root, name), 'utf8').trim().split('\n')).every(line => JSON.parse(line).timestamp)).toBe(true)
  })
  it('redacts credentials, private URLs and known speech content', () => {
    const value = redactDiagnostic('Request https://user:private@host.test/a?token=private#private authorization=Bearer private\n{"apiKey":"private"}\npassword: private')
    expect(value).not.toContain('private')
    expect(value).toContain('https://host.test/a')
    expect(redactDiagnostic('[voice] \u8bc6\u522b\u7ed3\u679c: private speech')).not.toContain('private speech')
  })
  it('does not crash when log storage is unavailable and retries when restored', () => {
    const directory = path.join(root, 'blocked'); fs.writeFileSync(directory, 'file')
    const log = createRuntimeLog(directory)
    expect(() => log.write('error', 'main', ['first'])).not.toThrow(); expect(log.failures).toBe(1)
    fs.unlinkSync(directory); log.write('info', 'main', ['second'])
    expect(fs.readdirSync(directory)).toHaveLength(1)
  })
})
