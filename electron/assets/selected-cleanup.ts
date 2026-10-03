import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { AiAssetsStore } from '../store/ai-assets-store.js'

const hashPattern = /^[a-f0-9]{64}$/

function hashFile(file: string): string {
  const descriptor = fs.openSync(file, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024)
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (!bytes) return hash.digest('hex')
      hash.update(buffer.subarray(0, bytes))
    }
  } finally { fs.closeSync(descriptor) }
}

function checkedVault(userData: string): string {
  const root = path.resolve(userData, 'ai-assets')
  if (fs.existsSync(root) && (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink())) throw new Error('资料目录不是普通目录，已停止清理')
  return root
}

function objectPath(root: string, hash: string): string {
  if (!hashPattern.test(hash)) throw new Error('Invalid original hash')
  const objects = path.join(root, 'objects'), prefix = path.join(objects, hash.slice(0, 2))
  for (const directory of [objects, prefix]) if (fs.existsSync(directory) && (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()))
    throw new Error('原件目录不是普通目录，已停止清理')
  return path.join(prefix, hash)
}

/** Database references decide recovery after an interrupted file move. */
export function recoverSelectedCleanup(userData: string, assets: AiAssetsStore): void {
  const root = checkedVault(userData), staging = path.join(root, '.selected-cleanup')
  if (!fs.existsSync(staging)) return
  if (!fs.lstatSync(staging).isDirectory() || fs.lstatSync(staging).isSymbolicLink()) throw new Error('清理恢复目录无效')
  for (const entry of fs.readdirSync(staging, { withFileTypes: true })) {
    if (!hashPattern.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) throw new Error('清理恢复目录中存在未知文件')
    const source = path.join(staging, entry.name)
    if (assets.referencesOriginal(entry.name)) {
      const destination = objectPath(root, entry.name)
      if (fs.existsSync(destination)) {
        const stat = fs.lstatSync(destination)
        if (!stat.isFile() || stat.isSymbolicLink() || hashFile(destination) !== entry.name) throw new Error('待恢复原件与当前原件存在冲突，请先备份并检查')
        fs.unlinkSync(source)
        continue
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.renameSync(source, destination)
    } else fs.unlinkSync(source)
  }
  fs.rmdirSync(staging)
}

export function cleanSelectedAttachments(userData: string, assets: AiAssetsStore, ids: string[]): { deleted: number; cleanupPending: boolean } {
  recoverSelectedCleanup(userData, assets)
  const root = checkedVault(userData), staging = path.join(root, '.selected-cleanup')
  const moved: Array<{ source: string; destination: string }> = []
  let committed = false
  try {
    const deleted = assets.deleteAttachments(ids, hashes => {
      for (const hash of hashes) {
        const source = objectPath(root, hash)
        if (!fs.existsSync(source)) continue
        const stat = fs.lstatSync(source)
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('原件不是普通文件，已停止清理')
        fs.mkdirSync(staging, { recursive: true })
        const destination = path.join(staging, hash)
        fs.renameSync(source, destination)
        moved.push({ source, destination })
      }
    })
    committed = true
    try { recoverSelectedCleanup(userData, assets); return { deleted, cleanupPending: false } }
    catch { return { deleted, cleanupPending: true } }
  } catch (error) {
    if (!committed) {
      for (const item of moved.reverse()) fs.renameSync(item.destination, item.source)
      if (fs.existsSync(staging)) fs.rmdirSync(staging)
    }
    throw error
  }
}
