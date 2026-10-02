import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, lstat, link, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { FileHandle } from 'node:fs/promises'

interface Transfer {
  file: string
  handle: FileHandle
  hash: ReturnType<typeof createHash>
  size: number
  tail: Promise<void>
}

const publications = new Map<string, Promise<void>>()

export class OriginalVault {
  private transfers = new Map<string, Transfer>()
  private starting = new Map<string, Promise<void>>()
  constructor(readonly root: string, private temporaryRoot = path.join(root, '.pending')) {}

  pathFor(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid original digest')
    return path.join(this.root, 'objects', hash.slice(0, 2), hash)
  }
  async begin(id: string): Promise<void> {
    if (this.transfers.has(id) || this.starting.has(id)) throw new Error('Original transfer already active')
    const operation = (async () => {
      await mkdir(this.temporaryRoot, { recursive: true })
      const file = path.join(this.temporaryRoot, randomUUID())
      const handle = await open(file, 'wx')
      this.transfers.set(id, { file, handle, hash: createHash('sha256'), size: 0, tail: Promise.resolve() })
    })()
    this.starting.set(id, operation)
    try { await operation }
    finally { if (this.starting.get(id) === operation) this.starting.delete(id) }
  }
  async append(id: string, offset: number, bytes: Uint8Array): Promise<void> {
    const transfer = this.transfers.get(id)
    if (!transfer) throw new Error('Original transfer not found')
    const operation = transfer.tail.then(async () => {
      if (offset !== transfer.size) throw new Error('Original transfer offset mismatch')
      let written = 0
      while (written < bytes.byteLength) {
        const result = await transfer.handle.write(bytes, written, bytes.byteLength - written, null)
        if (!result.bytesWritten) throw new Error('Original write was incomplete')
        written += result.bytesWritten
      }
      transfer.hash.update(bytes)
      transfer.size += bytes.byteLength
    })
    transfer.tail = operation.then(() => {}, () => {})
    await operation
  }
  async finish(id: string, expectedSize: number, expectedHash?: string): Promise<{ sha256: string; size: number; reused: boolean }> {
    const transfer = this.transfers.get(id)
    if (!transfer) throw new Error('Original transfer not found')
    await transfer.tail
    if (transfer.size !== expectedSize) throw new Error('Original transfer size mismatch')
    await transfer.handle.sync()
    await transfer.handle.close()
    this.transfers.delete(id)
    const sha256 = transfer.hash.digest('hex')
    try {
      if (expectedHash && sha256 !== expectedHash) throw new Error('Original digest differs from the saved reference')
      const reused = await this.publish(transfer.file, sha256, transfer.size, !!expectedHash)
      return { sha256, size: transfer.size, reused }
    } finally {
      await unlink(transfer.file).catch(() => {})
    }
  }
  private async publish(file: string, hash: string, size: number, recover: boolean): Promise<boolean> {
    const destination = this.pathFor(hash)
    const operation = (publications.get(destination) ?? Promise.resolve()).then(async () => {
      await mkdir(path.dirname(destination), { recursive: true })
      try { await link(file, destination); return false }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      try { await this.verify(hash, size); return true }
      catch (error) {
        if (!recover || !['Original size check failed', 'Original digest check failed'].includes((error as Error).message)) throw error
      }
      const quarantine = path.join(this.root, 'quarantine')
      await mkdir(quarantine, { recursive: true })
      await rename(destination, path.join(quarantine, `${hash}-${randomUUID()}`))
      await link(file, destination)
      return false
    })
    const completion = operation.then(() => {}, () => {})
    publications.set(destination, completion)
    try { return await operation }
    finally { if (publications.get(destination) === completion) publications.delete(destination) }
  }
  async verify(hash: string, size?: number): Promise<string> {
    const file = this.pathFor(hash)
    const fileStat = await lstat(file)
    if (!fileStat.isFile()) throw new Error('Original object is not a regular file')
    if (size !== undefined && fileStat.size !== size) throw new Error('Original size check failed')
    const calculated = createHash('sha256')
    for await (const chunk of createReadStream(file)) calculated.update(chunk)
    if (calculated.digest('hex') !== hash) throw new Error('Original digest check failed')
    return file
  }
  async abort(id: string): Promise<void> {
    await this.starting.get(id)?.catch(() => {})
    const transfer = this.transfers.get(id)
    if (!transfer) return
    this.transfers.delete(id)
    await transfer.tail
    await transfer.handle.close().catch(() => {})
    await unlink(transfer.file).catch(() => {})
  }
}
