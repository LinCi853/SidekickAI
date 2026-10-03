import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ execute: vi.fn(), executeSync: vi.fn(), helper: vi.fn() }))
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: fixture.execute }),
  execFileSync: fixture.executeSync,
}))
vi.mock('../packages/desktop-common/windows-startup-helper', () => ({ windowsStartupHelper: fixture.helper }))
import { applicationProcessOperation, applicationProcessOperationSync, prepareEditionSession } from '../packages/desktop-common/application-process'
import { editionSessionEndpoint } from '../packages/desktop-common/edition-session'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  vi.stubEnv('SIDEKICK_TEST_SESSION', '')
  vi.spyOn(fs, 'existsSync').mockReturnValue(true)
  fixture.execute.mockResolvedValue({ stdout: '{"ok":true}', stderr: '' })
  fixture.executeSync.mockReturnValue('3')
  fixture.helper.mockImplementation((_resources, input) => ({ executable: 'E:/installed/resources/windows/SidekickStartup.exe', args: [Buffer.from(JSON.stringify(input)).toString('base64')] }))
})
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('packaged startup dispatch', () => {
  it.each(['inspect', 'inspect-image', 'inventory', 'session'])('uses the verified executable for packaged %s calls', async action => {
    await applicationProcessOperation(action, { pid: 123 }, 'E:/installed/resources')
    expect(fixture.helper).toHaveBeenCalledWith('E:/installed/resources', { pid: 123, operation: action })
    expect(fixture.execute).toHaveBeenCalledWith('E:/installed/resources/windows/SidekickStartup.exe', expect.any(Array), expect.objectContaining({ windowsHide: true }))
  })

  it('uses the verified executable for synchronous session identity', () => {
    expect(applicationProcessOperationSync('session', { pid: 123 }, 'E:/installed/resources')).toBe(3)
    expect(fixture.helper).toHaveBeenCalledOnce()
    expect(fixture.executeSync).toHaveBeenCalledWith('E:/installed/resources/windows/SidekickStartup.exe', expect.any(Array), expect.objectContaining({ encoding: 'utf8' }))
  })

  it('does not start PowerShell when installed resource validation fails', async () => {
    fixture.helper.mockImplementation(() => { throw new Error('Resource identity changed') })
    await expect(applicationProcessOperation('inventory', {}, 'E:/installed/resources')).rejects.toThrow('Resource identity changed')
    expect(fixture.execute).not.toHaveBeenCalled()
  })

  it('retains the source script for development inspections', async () => {
    await applicationProcessOperation('inspect', { pid: 123 })
    expect(fixture.helper).not.toHaveBeenCalled()
    expect(fixture.execute).toHaveBeenCalledWith(expect.stringContaining('powershell.exe'), expect.arrayContaining(['-File', expect.stringContaining('application-process.ps1')]), expect.any(Object))
  })

  it('retains existing script dispatch for process-control operations', async () => {
    await applicationProcessOperation('request', { endpoint: 'pipe' }, 'E:/installed/resources')
    expect(fixture.helper).not.toHaveBeenCalled()
    expect(fixture.execute).toHaveBeenCalledWith(expect.stringContaining('powershell.exe'), expect.arrayContaining(['-File']), expect.any(Object))
  })

  it('prepares the packaged endpoint through its verified helper', async () => {
    await prepareEditionSession('pipe', 'E:/installed/resources')
    expect(fixture.helper).toHaveBeenCalledWith('E:/installed/resources', { operation: 'prepare-session', endpoint: 'pipe', server: process.pid })
    expect(fixture.execute).toHaveBeenCalledWith('E:/installed/resources/windows/SidekickStartup.exe', expect.any(Array), expect.objectContaining({ windowsHide: true, timeout: 10000 }))
  })

  it('keeps development pipe preparation on the existing script path', async () => {
    await prepareEditionSession('pipe')
    expect(fixture.helper).not.toHaveBeenCalled()
    expect(fixture.execute).toHaveBeenCalledWith(expect.stringContaining('powershell.exe'), expect.arrayContaining(['-Request']), expect.any(Object))
  })

  it('uses the compiled session identity only when packaged resources are supplied', () => {
    const installed = editionSessionEndpoint(undefined, 'concept', '', 'E:/installed/resources')
    expect(fixture.helper).toHaveBeenCalledWith('E:/installed/resources', { operation: 'session', pid: process.pid })
    fixture.helper.mockClear(); fixture.executeSync.mockClear()
    expect(editionSessionEndpoint()).toBe(installed)
    expect(fixture.helper).not.toHaveBeenCalled()
    expect(fixture.executeSync).toHaveBeenCalledWith('powershell.exe', expect.any(Array), expect.any(Object))
  })

  it('keeps isolated test endpoints independent from helper resources', () => {
    expect(editionSessionEndpoint('fixture', 'concept', '', 'E:/damaged/resources')).toContain('sidekick-editions-')
    expect(fixture.helper).not.toHaveBeenCalled()
    expect(fixture.executeSync).not.toHaveBeenCalled()
  })
})
