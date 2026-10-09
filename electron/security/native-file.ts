import fs from 'node:fs'
import path from 'node:path'
import { assertOrdinaryPath, samePath } from '../../packages/backup-core/io.js'

export interface NativeFile {
  descriptor: number
  path: string
  name: string
  identity: fs.BigIntStats
}

/** A native selection is resolved and pinned once; consumers use the open descriptor. */
export function openNativeFile(selected: string, writable = false): NativeFile {
  if (typeof selected !== 'string' || !path.isAbsolute(selected)) throw new Error('请选择有效的本地文件。')
  const resolved = path.resolve(selected)
  assertOrdinaryPath(path.dirname(resolved), true)
  const exists = fs.existsSync(resolved)
  if (exists) assertOrdinaryPath(resolved)
  const expected = exists ? fs.realpathSync.native(resolved) : path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved))
  const before = exists ? fs.statSync(resolved, { bigint: true }) : undefined
  const descriptor = fs.openSync(resolved, writable ? exists ? 'r+' : 'wx+' : 'r', 0o600)
  try {
    const identity = fs.fstatSync(descriptor, { bigint: true })
    assertOrdinaryPath(resolved)
    const real = fs.realpathSync.native(resolved)
    const current = fs.statSync(resolved, { bigint: true })
    if (!identity.isFile() || !samePath(real, expected) || current.dev !== identity.dev || current.ino !== identity.ino
      || before && (before.dev !== identity.dev || before.ino !== identity.ino)) throw new Error('所选文件已变化，请重新选择。')
    return { descriptor, path: real, name: path.basename(real), identity }
  } catch (error) { fs.closeSync(descriptor); throw error }
}

export function readNativeFile(file: NativeFile, maximum: number): Buffer {
  const before = fs.fstatSync(file.descriptor, { bigint: true })
  if (!before.isFile() || before.size > BigInt(maximum)) throw new Error('所选文件超过允许的大小。')
  const bytes = Buffer.alloc(Number(before.size))
  let position = 0
  while (position < bytes.length) {
    const length = fs.readSync(file.descriptor, bytes, position, bytes.length - position, position)
    if (!length) throw new Error('所选文件在读取时发生变化。')
    position += length
  }
  const after = fs.fstatSync(file.descriptor, { bigint: true })
  if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('所选文件在读取时发生变化。')
  return bytes
}
