import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { decryptFileStream, isSabkEncrypted } from './file-crypto.js'
import { readStreamingArchive } from './stream-archive.js'
import { exportOfflineBackup } from './offline.js'
import { cancelBackupJob, listBackupJobs, queryBackupJob, resumeBackupJob } from './jobs.js'
import { assertOrdinaryPath, checkDiskSpace, createPrivateDirectory, hashFile } from './io.js'
import type { BackupEdition } from './types.js'

function value(args: string[], key: string): string | undefined {
  const index = args.indexOf(key)
  if (index < 0) return undefined
  const next = args[index + 1]
  if (!next || next.startsWith('--')) throw new Error(`Missing value for ${key}.`)
  return next
}
function required(args: string[], key: string): string { const item = value(args, key); if (!item) throw new Error(`Required argument: ${key}`); return item }
async function passwordInput(args: string[]): Promise<string | undefined> {
  if (!args.includes('--password-stdin')) return undefined
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > 64 * 1024) throw new Error('Password input exceeds the supported length.')
    chunks.push(Buffer.from(chunk))
  }
  const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
  if (!password) throw new Error('Password input is empty.')
  return password
}

export async function runBackupCli(args: string[]): Promise<unknown> {
  const command = args[0]
  const tempRoot = value(args, '--temp-root')
  const password = await passwordInput(args)
  if (command === 'jobs') return listBackupJobs(tempRoot)
  if (command === 'status') return queryBackupJob(required(args, '--job'), tempRoot)
  if (command === 'resume') return resumeBackupJob(required(args, '--job'), { tempRoot, password, targetPath: value(args, '--target') })
  if (command === 'cancel') return cancelBackupJob(required(args, '--job'), tempRoot, { discard: args.includes('--discard') })
  if (command === 'export') {
    const edition = required(args, '--edition')
    if (!['community', 'concept'].includes(edition)) throw new Error('Edition must be community or concept.')
    return exportOfflineBackup({ sourceRoot: path.resolve(required(args, '--source')), edition: edition as BackupEdition, version: value(args, '--version') ?? 'standalone',
      targetPath: path.resolve(required(args, '--target')), password, tempRoot, jobId: value(args, '--job'), strict: true,
      options: { basicData: true, cookies: !args.includes('--exclude-cookies'), indexedDB: !args.includes('--exclude-indexeddb'), cache: !args.includes('--exclude-cache') } })
  }
  if (['verify', 'restore', 'decrypt'].includes(command)) {
    const file = path.resolve(required(args, '--file'))
    assertOrdinaryPath(file)
    const temporaryRoot = path.resolve(tempRoot ?? os.tmpdir())
    fs.mkdirSync(temporaryRoot, { recursive: true, mode: 0o700 })
    assertOrdinaryPath(temporaryRoot, true)
    const directory = fs.mkdtempSync(path.join(temporaryRoot, 'sidekick-independent-backup-'))
    createPrivateDirectory(directory)
    let restoreStaging: string | undefined
    try {
      let input = file
      if (isSabkEncrypted(file)) {
        if (!password) throw new Error('Encrypted backup requires --password-stdin.')
        checkDiskSpace([{ path: directory, bytes: fs.statSync(file).size, purpose: '独立解密' }])
        input = path.join(directory, 'decrypted.zip')
        if (!await decryptFileStream(file, input, password)) throw new Error('Password is incorrect or the encrypted archive is corrupt.')
      } else if (command === 'decrypt') throw new Error('Input is not an encrypted SABK backup.')
      const target = command === 'restore' || command === 'decrypt' ? path.resolve(required(args, '--target')) : undefined
      if (target && fs.existsSync(target)) throw new Error('Independent restore and decrypt require a new destination.')
      if (command === 'restore') {
        assertOrdinaryPath(path.dirname(target!), true)
        restoreStaging = fs.mkdtempSync(path.join(path.dirname(target!), '.sidekick-restore-'))
        createPrivateDirectory(restoreStaging)
      }
      const manifest = await readStreamingArchive(input, { allowLegacy: true, extractTo: restoreStaging })
      if (restoreStaging) {
        if (fs.existsSync(target!)) throw new Error('Independent restore requires a new destination.')
        fs.renameSync(restoreStaging, target!)
        restoreStaging = undefined
      }
      if (command === 'decrypt') {
        checkDiskSpace([{ path: path.dirname(target!), bytes: fs.statSync(input).size, purpose: '解密目标' }])
        fs.copyFileSync(input, target!, fs.constants.COPYFILE_EXCL)
      }
      return { success: true, sha256: await hashFile(file), manifest, ...(target ? { targetPath: target } : {}) }
    } finally {
      if (restoreStaging) fs.rmSync(restoreStaging, { recursive: true, force: true })
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
  throw new Error('Commands: export, verify, decrypt, restore, jobs, status, resume, cancel. Passwords are accepted only through --password-stdin.')
}
