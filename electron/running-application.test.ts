import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { identifyRunningApplications, packageIdentity } from '../packages/desktop-common/running-application'

const directories: string[] = []
afterEach(() => directories.splice(0).forEach(directory => fs.rmSync(directory, { recursive: true, force: true })))

function archive(value: object) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'running-package-'))
  directories.push(directory)
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.from(JSON.stringify({ files: { 'package.json': { size: body.length, offset: '0' } } }))
  const prefix = Buffer.alloc(16)
  prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(8 + header.length, 4); prefix.writeUInt32LE(header.length, 12)
  const file = path.join(directory, 'app.archive')
  fs.writeFileSync(file, Buffer.concat([prefix, header, body]))
  return file
}

describe('historic running application detection', () => {
  it('reads a bounded package identity and rejects a truncated archive', () => {
    const value = { name: 'sidekick-ai', version: '0.1.0-beta.4' }
    const file = archive(value)
    expect(packageIdentity(file)).toEqual(value)
    fs.truncateSync(file, 12)
    expect(packageIdentity(file)).toBeNull()
  })
  it('uses package identity instead of the shared executable name', () => {
    const rows = [{ ProcessId: 50, ExecutablePath: 'E:/custom/SidekickAI.exe', CommandLine: '"E:/custom/SidekickAI.exe"' }]
    expect(identifyRunningApplications(rows, 1, () => ({ name: 'foreign', version: '1' }))).toEqual([])
    expect(identifyRunningApplications(rows, 1, () => ({ name: 'sidekick-ai', version: '0.1.0-beta.4' }))).toMatchObject([{ pid: 50, edition: 'community', version: '0.1.0-beta.4' }])
  })
  it('excludes the caller, Chromium children, export tools and coordinated applications', () => {
    const base = { ExecutablePath: 'E:/custom/SidekickAI.exe', CommandLine: '"E:/custom/SidekickAI.exe"' }
    const read = () => ({ name: 'sidekick-ai', version: '0.1.0-beta.5' })
    expect(identifyRunningApplications([{ ...base, ProcessId: 1 }, { ...base, ProcessId: 2, CommandLine: base.CommandLine + ' --type=renderer' }, { ...base, ProcessId: 3, CommandLine: base.CommandLine + ' --export-user-data request.json' }], 1, read)).toEqual([])
    expect(identifyRunningApplications([{ ...base, ProcessId: 50 }], 1, () => ({ ...read(), editionSessionProtocol: 2 }))).toEqual([])
  })
  it('uses native identity when CIM command-line access is unavailable', () => {
    const rows = [{ ProcessId: 50, ExecutablePath: 'E:/custom/SidekickAI.exe', Started: '123', Sid: 'fixture-user', Session: 1 }]
    expect(identifyRunningApplications(rows, 1, () => ({ name: 'sidekick-ai', version: '0.1.6' }))).toMatchObject([{ pid: 50, version: '0.1.6', started: '123', sid: 'fixture-user', session: 1 }])
    expect(identifyRunningApplications([{ ProcessId: 51, ExecutablePath: rows[0].ExecutablePath }], 1, () => ({ name: 'sidekick-ai', version: '0.1.6' }))).toEqual([])
  })
  it('excludes same-image children by parentage when their command line is unavailable', () => {
    const owner = { ProcessId: 50, ExecutablePath: 'E:/custom/SidekickAI.exe', Started: '123', Sid: 'fixture-user', Session: 1 }
    const rows = [owner, { ...owner, ProcessId: 51, ParentProcessId: 50 }]
    expect(identifyRunningApplications(rows, 1, () => ({ name: 'sidekick-ai', version: '0.1.6' }))).toHaveLength(1)
  })
})
