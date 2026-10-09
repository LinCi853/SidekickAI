import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { checkAbort, flushFile, STREAM_BUFFER_BYTES } from './io.js'

const MAGIC = Buffer.from('SABK')
const VERSION = 2
const SALT_LENGTH = 32
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16
const KEY_LENGTH = 32
const PBKDF2_ITERATIONS = 100000
const MAX_SALT_BYTES = 64 * 1024
export const SABK_MAX_PLAINTEXT_BYTES = 2 ** 36 - 32

function validatePlaintextSize(file: string): void {
  if (fs.statSync(file).size > SABK_MAX_PLAINTEXT_BYTES) throw new Error('SABK cannot encrypt more than 68719476704 bytes in one authenticated archive. Choose a smaller explicit selection.')
}

interface Header { deviceId: string; salt: Buffer; iv: Buffer; tag: Buffer; length: number; aad?: Buffer }
export interface CryptoProgress { signal?: AbortSignal; cancelled?: () => boolean; onBytes?: (bytes: number) => void }

function key(password: string, salt: Buffer): Buffer {
  if (!password) throw new Error('备份加密密码不能为空。')
  return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256')
}

function makeHeader(deviceId: string, salt: Buffer, iv: Buffer): Buffer {
  const identity = Buffer.from(deviceId, 'utf8')
  if (!identity.length || identity.length > MAX_SALT_BYTES) throw new Error('Invalid backup encryption identity.')
  const header = Buffer.alloc(13 + salt.length + identity.length + IV_LENGTH + AUTH_TAG_LENGTH)
  MAGIC.copy(header)
  header[4] = VERSION
  header.writeUInt32LE(salt.length, 5)
  header.writeUInt32LE(identity.length, 9)
  salt.copy(header, 13)
  identity.copy(header, 13 + salt.length)
  iv.copy(header, 13 + salt.length + identity.length)
  return header
}

function readHeader(file: string): Header | null {
  const descriptor = fs.openSync(file, 'r')
  try {
    const prefix = Buffer.alloc(9)
    if (fs.readSync(descriptor, prefix, 0, 9, 0) !== 9 || !prefix.subarray(0, 4).equals(MAGIC) || ![1, VERSION].includes(prefix[4])) return null
    const saltLength = prefix.readUInt32LE(5)
    if (!saltLength || saltLength > MAX_SALT_BYTES) return null
    if (prefix[4] === VERSION) {
      if (saltLength !== SALT_LENGTH) return null
      const identitySize = Buffer.alloc(4)
      if (fs.readSync(descriptor, identitySize, 0, 4, 9) !== 4) return null
      const identityLength = identitySize.readUInt32LE()
      if (!identityLength || identityLength > MAX_SALT_BYTES) return null
      const body = Buffer.alloc(saltLength + identityLength + IV_LENGTH + AUTH_TAG_LENGTH)
      if (fs.readSync(descriptor, body, 0, body.length, 13) !== body.length) return null
      const ivOffset = saltLength + identityLength
      return { deviceId: body.subarray(saltLength, ivOffset).toString('utf8'), salt: body.subarray(0, saltLength),
        iv: body.subarray(ivOffset, ivOffset + IV_LENGTH), tag: body.subarray(ivOffset + IV_LENGTH), length: 13 + body.length,
        aad: Buffer.concat([prefix, identitySize, body.subarray(0, -AUTH_TAG_LENGTH)]) }
    }
    const body = Buffer.alloc(saltLength + IV_LENGTH + AUTH_TAG_LENGTH)
    if (fs.readSync(descriptor, body, 0, body.length, 9) !== body.length) return null
    return { deviceId: body.subarray(0, saltLength).toString('utf8'), salt: body.subarray(0, saltLength), iv: body.subarray(saltLength, saltLength + IV_LENGTH), tag: body.subarray(saltLength + IV_LENGTH), length: 9 + body.length }
  } finally { fs.closeSync(descriptor) }
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0
  while (offset < bytes.length) { const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset); if (!written) throw new Error('Backup encryption write made no progress.'); offset += written }
}

/** The complete envelope header except the tag is authenticated as GCM additional data. */
export function encryptFile(inputPath: string, outputPath: string, password: string, deviceId: string): void {
  validatePlaintextSize(inputPath)
  const salt = randomBytes(SALT_LENGTH)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key(password, salt), iv)
  const header = makeHeader(deviceId, salt, iv)
  cipher.setAAD(header.subarray(0, -AUTH_TAG_LENGTH))
  const input = fs.openSync(inputPath, 'r')
  const output = fs.openSync(outputPath, 'w', 0o600)
  try {
    writeAll(output, header)
    const buffer = Buffer.allocUnsafe(STREAM_BUFFER_BYTES)
    for (;;) {
      const length = fs.readSync(input, buffer, 0, buffer.length, null)
      if (!length) break
      writeAll(output, cipher.update(buffer.subarray(0, length)))
    }
    writeAll(output, cipher.final())
    fs.writeSync(output, cipher.getAuthTag(), 0, AUTH_TAG_LENGTH, header.length - AUTH_TAG_LENGTH)
    fs.fsyncSync(output)
  } finally { fs.closeSync(input); fs.closeSync(output) }
}

/** Unauthenticated plaintext is never published at the requested destination. */
export function decryptFile(inputPath: string, outputPath: string, password: string): string | null {
  const header = readHeader(inputPath)
  if (!header) return null
  const scratch = `${outputPath}.${randomUUID()}.decrypting`
  const decipher = createDecipheriv('aes-256-gcm', key(password, header.salt), header.iv)
  if (header.aad) decipher.setAAD(header.aad)
  decipher.setAuthTag(header.tag)
  const input = fs.openSync(inputPath, 'r')
  const output = fs.openSync(scratch, 'wx', 0o600)
  let authenticated = false
  try {
    const buffer = Buffer.allocUnsafe(STREAM_BUFFER_BYTES)
    let position = header.length
    for (;;) {
      const length = fs.readSync(input, buffer, 0, buffer.length, position)
      if (!length) break
      position += length
      writeAll(output, decipher.update(buffer.subarray(0, length)))
    }
    try { writeAll(output, decipher.final()); authenticated = true } catch { return null }
    fs.fsyncSync(output)
  } finally {
    fs.closeSync(input); fs.closeSync(output)
    if (!authenticated) fs.rmSync(scratch, { force: true })
  }
  try { fs.renameSync(scratch, outputPath) }
  finally { fs.rmSync(scratch, { force: true }) }
  return header.deviceId
}

function meter(options: CryptoProgress): Transform {
  let bytes = 0
  return new Transform({ transform(chunk: Buffer, _encoding, callback) {
    try { checkAbort(options.signal, options.cancelled); bytes += chunk.length; options.onBytes?.(bytes); callback(null, chunk) }
    catch (error) { callback(error as Error) }
  } })
}

export async function encryptFileStream(inputPath: string, outputPath: string, password: string, deviceId: string, options: CryptoProgress = {}): Promise<void> {
  validatePlaintextSize(inputPath)
  checkAbort(options.signal, options.cancelled)
  const salt = randomBytes(SALT_LENGTH)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key(password, salt), iv)
  const header = makeHeader(deviceId, salt, iv)
  cipher.setAAD(header.subarray(0, -AUTH_TAG_LENGTH))
  fs.writeFileSync(outputPath, header, { mode: 0o600 })
  try {
    await pipeline(fs.createReadStream(inputPath, { highWaterMark: STREAM_BUFFER_BYTES }), meter(options), cipher, fs.createWriteStream(outputPath, { flags: 'r+', start: header.length, highWaterMark: STREAM_BUFFER_BYTES }), { signal: options.signal })
    const descriptor = fs.openSync(outputPath, 'r+')
    try { fs.writeSync(descriptor, cipher.getAuthTag(), 0, AUTH_TAG_LENGTH, header.length - AUTH_TAG_LENGTH); fs.fsyncSync(descriptor) }
    finally { fs.closeSync(descriptor) }
  } catch (error) { fs.rmSync(outputPath, { force: true }); throw error }
}

export async function decryptFileStream(inputPath: string, outputPath: string, password: string, options: CryptoProgress = {}): Promise<string | null> {
  checkAbort(options.signal, options.cancelled)
  const header = readHeader(inputPath)
  if (!header) return null
  const scratch = `${outputPath}.${randomUUID()}.decrypting`
  const decipher = createDecipheriv('aes-256-gcm', key(password, header.salt), header.iv)
  if (header.aad) decipher.setAAD(header.aad)
  decipher.setAuthTag(header.tag)
  try {
    await pipeline(fs.createReadStream(inputPath, { start: header.length, highWaterMark: STREAM_BUFFER_BYTES }), meter(options), decipher, fs.createWriteStream(scratch, { flags: 'wx', mode: 0o600, highWaterMark: STREAM_BUFFER_BYTES }), { signal: options.signal })
    flushFile(scratch)
    fs.renameSync(scratch, outputPath)
    return header.deviceId
  } catch (error) {
    const message = (error as Error).message
    if (/unable to authenticate|authenticat|bad decrypt/i.test(message)) return null
    throw error
  } finally { fs.rmSync(scratch, { force: true }) }
}

export function isSabkEncrypted(filePath: string): boolean {
  try {
    const descriptor = fs.openSync(filePath, 'r')
    try { const header = Buffer.alloc(4); return fs.readSync(descriptor, header, 0, 4, 0) === 4 && header.equals(MAGIC) }
    finally { fs.closeSync(descriptor) }
  } catch { return false }
}
