// electron/utils/file-crypto.ts — 文件级加密/解密
//
// 用于备份文件加密。格式：SABK(4) + version(1) + saltLen(4) + salt + iv(12) + authTag(16) + ciphertext
// 密钥派生：PBKDF2-SHA256，100000 迭代，salt = deviceId UTF-8 字节

import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'crypto'
import { closeSync, openSync, readFileSync, readSync, writeFileSync } from 'fs'

const MAGIC = Buffer.from('SABK')
const VERSION = 1
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16
const KEY_LENGTH = 32
const PBKDF2_ITERATIONS = 100000

/**
 * 加密文件。密码 + deviceId 作为盐派生密钥。
 * @param inputPath 输入文件路径（明文 zip）
 * @param outputPath 输出文件路径（加密 .sabackup）
 * @param password 用户密码
 * @param deviceId 设备唯一码（作为 salt）
 */
export function encryptFile(inputPath: string, outputPath: string, password: string, deviceId: string): void {
  const plaintext = readFileSync(inputPath)
  const salt = Buffer.from(deviceId, 'utf-8')
  const key = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256')
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const authTag = cipher.getAuthTag()

  // 组装：MAGIC + VERSION + saltLen(4字节) + salt + IV + authTag + ciphertext
  const saltLen = Buffer.alloc(4)
  saltLen.writeUInt32LE(salt.length, 0)
  const output = Buffer.concat([MAGIC, Buffer.from([VERSION]), saltLen, salt, iv, authTag, encrypted])
  writeFileSync(outputPath, output)
}

/**
 * 解密文件。从文件头提取 salt（deviceId），用密码派生密钥解密。
 * @returns 来源 deviceId，失败返回 null
 */
export function decryptFile(inputPath: string, outputPath: string, password: string): string | null {
  const data = readFileSync(inputPath)

  // 校验魔数
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

/** 检测文件是否为 SABK 加密格式（只读文件头，避免大备份全量读入） */
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
