'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { pipeline } = require('node:stream/promises')
const yazl = require('yazl')
const yauzl = require('yauzl')
const crc32 = require('buffer-crc32')
const { validateRelativePath } = require('./application-runtime.cjs')

async function createArchive(directory, destination, request) {
  const zip = new yazl.ZipFile()
  const output = fs.createWriteStream(destination, { flags: 'wx' })
  zip.on('error', error => output.destroy(error))
  const written = pipeline(zip.outputStream, output)
  try {
    for (const file of request.files) {
      validateRelativePath(file.path)
      const source = path.join(directory, ...file.path.split('/'))
      const stat = fs.lstatSync(source)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size) throw new Error('Archive input identity changed')
      zip.addFile(source, file.path, { mtime: new Date('2026-01-01T00:00:00.000Z'), mode: 0o100644, compressionLevel: 5 })
    }
    for (const name of request.emptyDirectories || []) {
      validateRelativePath(name.replace(/\/$/, ''))
      zip.addEmptyDirectory(name, { mtime: new Date('2026-01-01T00:00:00.000Z'), mode: 0o40755 })
    }
    zip.end()
    await written
  } catch (error) {
    zip.outputStream.destroy(error)
    await written.catch(() => {})
    throw error
  }
}

async function verifyArchive(archive, files, { emptyDirectories = [] } = {}) {
  const expected = files ? new Map(files.map(file => [file.path, file])) : null
  if (expected && expected.size !== files.length) throw new Error('Duplicate archive inventory path')
  const directories = new Set(emptyDirectories.map(name => name.replace(/\/$/, '')))
  for (const file of files || []) {
    const parts = file.path.split('/')
    for (let count = 1; count < parts.length; count++) directories.add(parts.slice(0, count).join('/'))
  }
  const seen = new Set()
  const zip = await yauzl.openPromise(archive, { autoClose: false, validateEntrySizes: true, strictFileNames: true })
  try {
    for await (const entry of zip.eachEntry()) {
      const directory = entry.fileName.endsWith('/')
      validateRelativePath(directory ? entry.fileName.slice(0, -1) : entry.fileName)
      const name = entry.fileName.replace(/\/$/, '').toLowerCase()
      if (seen.has(name)) throw new Error('Duplicate archive path')
      seen.add(name)
      const mode = entry.externalFileAttributes >>> 16
      const type = mode & 0o170000
      if (type && type !== (directory ? 0o040000 : 0o100000) || entry.isEncrypted()) throw new Error('Nonregular or encrypted archive entries are forbidden')
      if (directory) {
        if (entry.uncompressedSize !== 0) throw new Error('Archive directory contains data')
        if (expected && !directories.has(entry.fileName.slice(0, -1))) throw new Error('Archive directory is outside the file inventory')
        continue
      }
      const identity = expected?.get(entry.fileName)
      if (expected && (!identity || entry.uncompressedSize !== identity.size)) throw new Error('Archive file inventory does not match')
      const digest = crypto.createHash('sha256')
      let size = 0, crc = 0
      const stream = await zip.openReadStreamPromise(entry)
      for await (const chunk of stream) {
        size += chunk.length
        crc = crc32.unsigned(chunk, crc)
        digest.update(chunk)
      }
      if (size !== entry.uncompressedSize || crc !== entry.crc32 || identity && digest.digest('hex') !== identity.sha256) {
        throw new Error('Archive file checksum does not match')
      }
      expected?.delete(entry.fileName)
    }
    if (expected?.size) throw new Error('Archive inventory files are missing')
  } finally { zip.close() }
}

async function main(args = process.argv.slice(2)) {
  if (args[0] === 'create' && args.length === 4) return createArchive(args[1], args[2], JSON.parse(fs.readFileSync(args[3], 'utf8')))
  if (args[0] === 'verify' && [2, 3].includes(args.length)) {
    const request = args[2] ? JSON.parse(fs.readFileSync(args[2], 'utf8')) : {}
    return verifyArchive(args[1], request.files, request)
  }
  throw new Error('Usage: application-archive.cjs create <directory> <archive> <inventory> | verify <archive> [inventory]')
}

module.exports = { createArchive, verifyArchive }
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
