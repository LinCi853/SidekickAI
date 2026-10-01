import AdmZip from 'adm-zip'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { encryptFile } from './file-crypto.js'
export type ExportTreeTuple = [string, number, number, string]

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}


const MAX_SAFE_TREE_LENGTH = 9007199254740991


export function sha256FileSync(filePath: string): string {
  const hash = createHash('sha256')
  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024)
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (read <= 0) break
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}


export function collectExportTreeTuples(root: string, current: string, tuples: ExportTreeTuple[]): void {
  for (const name of fs.readdirSync(current)) {
    if (Buffer.from(name, 'utf8').toString('utf8') !== name) {
      throw new Error(`Backup data tree contains a name that is not valid UTF-8: ${current}`)
    }
    const full = path.join(current, name)
    const stat = fs.lstatSync(full)
    const relative = path.relative(root, full).split(path.sep).join('/')
    if (stat.isSymbolicLink()) {
      throw new Error(`Backup data tree contains a symbolic link or junction: ${relative}`)
    }
    const hexPath = Buffer.from(relative, 'utf8').toString('hex')
    if (stat.isDirectory()) {
      tuples.push([hexPath, 1, 0, ''])
      collectExportTreeTuples(root, full, tuples)
    } else if (stat.isFile()) {
      if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_SAFE_TREE_LENGTH) {
        throw new Error(`Backup data tree entry has an unsupported length: ${relative}`)
      }
      tuples.push([hexPath, 2, stat.size, sha256FileSync(full)])
    } else {
      throw new Error(`Backup data tree contains a non-regular entry: ${relative}`)
    }
  }
}


export function exportTreeDigest(root: string): string {
  const stat = fs.lstatSync(root)
  if (stat.isSymbolicLink()) throw new Error(`Backup data root is a symbolic link or junction: ${root}`)
  if (!stat.isDirectory()) throw new Error(`Backup data root is not a directory: ${root}`)
  const tuples: ExportTreeTuple[] = []
  collectExportTreeTuples(root, root, tuples)
  tuples.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
  return sha256Hex(Buffer.from(JSON.stringify(tuples), 'utf8'))
}


export function existingOutputError(targetPath: string): string {
  return `Strict export refuses to overwrite an existing backup (already exists): ${targetPath}`
}


export function publishExclusive(
  scratchPath: string,
  targetPath: string,
  io: Pick<typeof fs, 'linkSync' | 'copyFileSync'> = fs,
): void {
  try {
    io.linkSync(scratchPath, targetPath)
    return
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST') throw new Error(existingOutputError(targetPath))
    if (code !== 'EXDEV' && code !== 'ENOSYS' && code !== 'EPERM' && code !== 'EACCES') throw err
  }
  try {
    io.copyFileSync(scratchPath, targetPath, fs.constants.COPYFILE_EXCL)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST') throw new Error(existingOutputError(targetPath))
    throw err
  }
}


export async function writeStrictArchive(
  targetPath: string,
  zip: AdmZip,
  encrypt: { password: string } | undefined,
  deviceId: string,
  reverifySources: () => Promise<void>,
  encryptWriter = encryptFile,
): Promise<void> {
  const resolvedTarget = path.resolve(targetPath)
  const directory = path.dirname(resolvedTarget)
  const scratchBase = path.join(directory, `.${path.basename(resolvedTarget)}.partial-${process.pid}-${randomUUID()}`)
  const plainZip = `${scratchBase}.zip`
  const cipherFile = `${scratchBase}.sabackup`
  try {
    zip.writeZip(plainZip)
    let publishSource = plainZip
    if (encrypt) {
      encryptWriter(plainZip, cipherFile, encrypt.password, deviceId)
      publishSource = cipherFile
    }
    await reverifySources()
    publishExclusive(publishSource, resolvedTarget)
  } finally {
    for (const file of [plainZip, cipherFile]) {
      try { fs.rmSync(file, { force: true }) } catch {  }
    }
  }
}


export function writePartialArchive(
  targetPath: string,
  zip: AdmZip,
  encrypt: { password: string } | undefined,
  deviceId: string,
  encryptWriter = encryptFile,
): void {
  const scratch = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${randomUUID()}`)
  const zipPath = `${scratch}.zip`
  const encryptedPath = `${scratch}.sabackup`
  try {
    zip.writeZip(zipPath)
    if (encrypt) encryptWriter(zipPath, encryptedPath, encrypt.password, deviceId)
    fs.renameSync(encrypt ? encryptedPath : zipPath, targetPath)
  } finally {
    for (const file of [zipPath, encryptedPath]) {
      try { fs.rmSync(file, { force: true }) } catch {  }
    }
  }
}
