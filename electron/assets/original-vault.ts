import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, stat, link, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { FileHandle } from 'node:fs/promises'

interface Transfer {
  file: string
  handle: FileHandle
  hash: ReturnType<typeof createHash>
  size: number
  tail: Promise<void>
}

export class OriginalVault {
  private transfers = new Map<string, Transfer>()
  constructor(readonly root: string, private temporaryRoot = path.join(root, '.pending')) {}

  pathFor(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid original digest')
    return path.join(this.root, 'objects', hash.slice(0, 2), hash)
  }
  async begin(id: string): Promise<void> {
    if (this.transfers.has(id)) throw new Error('Original transfer already active')
    const directory = this.temporaryRoot
    await mkdir(directory, { recursive: true })
    const file = path.join(directory, randomUUID())
    const handle = await open(file, 'wx')
    this.transfers.set(id, { file, handle, hash: createHash('sha256'), size: 0, tail: Promise.resolve() })
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
  async finish(id: string, expectedSize: number): Promise<{ sha256: string; size: number; reused: boolean }> {
    const transfer = this.transfers.get(id)
    if (!transfer) throw new Error('Original transfer not found')
    await transfer.tail
    if (transfer.size !== expectedSize) throw new Error('Original transfer size mismatch')
    await transfer.handle.sync()
    await transfer.handle.close()
    this.transfers.delete(id)
    const sha256 = transfer.hash.digest('hex')
    const destination = this.pathFor(sha256)
    let reused = false
    try {
      await mkdir(path.dirname(destination), { recursive: true })
      await link(transfer.file, destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await this.verify(sha256, transfer.size)
      reused = true
    } finally {
      await unlink(transfer.file).catch(() => {})
    }
    return { sha256, size: transfer.size, reused }
  }
  async verify(hash: string, size?: number): Promise<string> {
    const file = this.pathFor(hash)
    const fileStat = await stat(file)
    if (!fileStat.isFile() || (size !== undefined && fileStat.size !== size)) throw new Error('Original size check failed')
    const calculated = createHash('sha256')
    for await (const chunk of createReadStream(file)) calculated.update(chunk)
    if (calculated.digest('hex') !== hash) throw new Error('Original digest check failed')
    return file
  }
  async abort(id: string): Promise<void> {
    const transfer = this.transfers.get(id)
    if (!transfer) return
    this.transfers.delete(id)
    await transfer.tail
    await transfer.handle.close().catch(() => {})
    await unlink(transfer.file).catch(() => {})
  }
}
