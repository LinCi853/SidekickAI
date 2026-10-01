
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'crypto'
import { closeSync, openSync, readFileSync, readSync, writeFileSync } from 'fs'

const MAGIC = Buffer.from('SABK')
const VERSION = 1
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16
const KEY_LENGTH = 32
const PBKDF2_ITERATIONS = 100000


export function encryptFile(inputPath: string, outputPath: string, password: string, deviceId: string): void {
  const plaintext = readFileSync(inputPath)
  const salt = Buffer.from(deviceId, 'utf-8')
  const key = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256')
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const authTag = cipher.getAuthTag()
  const saltLen = Buffer.alloc(4)
  saltLen.writeUInt32LE(salt.length, 0)
  const output = Buffer.concat([MAGIC, Buffer.from([VERSION]), saltLen, salt, iv, authTag, encrypted])
  writeFileSync(outputPath, output)
}


export function decryptFile(inputPath: string, outputPath: string, password: string): string | null {
  const data = readFileSync(inputPath)
  if (data.length < 4 + 1 + 4 || !data.subarray(0, 4).equals(MAGIC)) {
    return null
  }

  const version = data[4]
  if (version !== VERSION) return null

  const saltLen = data.readUInt32LE(5)
  const saltStart = 9
  const saltEnd = saltStart + saltLen
  const deviceId = data.subarray(saltStart, saltEnd).toString('utf-8')

  const iv = data.subarray(saltEnd, saltEnd + IV_LENGTH)
  const authTag = data.subarray(saltEnd + IV_LENGTH, saltEnd + IV_LENGTH + AUTH_TAG_LENGTH)
  const ciphertext = data.subarray(saltEnd + IV_LENGTH + AUTH_TAG_LENGTH)

  const salt = Buffer.from(deviceId, 'utf-8')
  const key = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256')

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(authTag)
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    writeFileSync(outputPath, decrypted)
    return deviceId
  } catch {
    return null
  }
}


export function isSabkEncrypted(filePath: string): boolean {
  try {
    const fd = openSync(filePath, 'r')
    try {
      const header = Buffer.alloc(4)
      const n = readSync(fd, header, 0, 4, 0)
      return n === 4 && header.equals(MAGIC)
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}
