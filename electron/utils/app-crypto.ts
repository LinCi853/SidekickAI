// electron/utils/app-crypto.ts — 应用内加密工具
//
// 使用 AES-256-GCM 加密敏感数据（如 API Key），密钥存储在 app-key.json 文件中。
// 密钥文件与 Profile 等数据同等保护级别，可随数据一起跨设备迁移，
// 解决 safeStorage 绑定 OS 用户导致跨设备无法解密的问题。

import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'crypto'
import { createSqliteJsonStore } from '../store/module-state-store.js'

/** 应用密钥文件结构 */
interface AppKeyFile {
  version: number
  /** base64 编码的 32 字节随机密钥（AES-256 所需） */
  key: string
  createdAt: number
}

/** 密钥文件存储实例（写入 app-key.json） */
const keyStore = createSqliteJsonStore<AppKeyFile>({
  tableName: 'app_key',
  defaults: {
    version: 1,
    key: '',
    createdAt: 0,
  },
})

/** 加密格式前缀 */
const AES_PREFIX = 'aes:'

/** IV 长度（GCM 推荐 12 字节） */
const IV_LENGTH = 12
/** GCM 认证标签长度 */
const AUTH_TAG_LENGTH = 16
/** AES-256 密钥长度 */
const KEY_LENGTH = 32

/**
 * 获取或创建应用密钥。
 * 首次调用时生成随机密钥并持久化到 app-key.json。
 */
function getAppKey(): Buffer {
  const stored = keyStore.get('key')
  if (stored) {
    const key = Buffer.from(stored, 'base64')
    if (key.length === KEY_LENGTH) return key
    console.warn('[app-crypto] 密钥文件损坏（长度不匹配），重新生成')
  }
  // 生成新密钥
  const newKey = randomBytes(KEY_LENGTH)
  keyStore.set('version', 1)
  keyStore.set('key', newKey.toString('base64'))
  keyStore.set('createdAt', Date.now())
  return newKey
}

/** 缓存的密钥（避免每次加密/解密都读 store） */
let cachedKey: Buffer | null = null

/** 获取缓存的密钥（首次调用时加载） */
function getCachedKey(): Buffer {
  if (!cachedKey) {
    cachedKey = getAppKey()
  }
  return cachedKey
}

/**
 * 加密字符串。
 * 返回格式：`aes:<base64(IV + ciphertext + authTag)>`
 */
export function encryptString(plain: string): string {
  if (!plain) return ''
  const key = getCachedKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv)

  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  // 拼接 IV + 密文 + 认证标签，统一 base64 编码
  const combined = Buffer.concat([iv, encrypted, authTag])
  return AES_PREFIX + combined.toString('base64')
}

/**
 * 解密字符串。
 * 自动识别 `aes:` 前缀格式。
 * @throws 如果密文损坏或认证失败
 */
export function decryptString(cipher: string): string {
  if (!cipher) return ''
  if (!cipher.startsWith(AES_PREFIX)) {
    throw new Error('不是 AES 加密格式（缺少 aes: 前缀）')
  }
  const key = getCachedKey()
  const combined = Buffer.from(cipher.slice(AES_PREFIX.length), 'base64')

  // 拆分 IV + 密文 + 认证标签
  const iv = combined.subarray(0, IV_LENGTH)
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH)
  const encrypted = combined.subarray(IV_LENGTH, combined.length - AUTH_TAG_LENGTH)

  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
  return decrypted.toString('utf8')
}

/**
 * 判断密文是否为 AES 加密格式。
 */
export function isAesEncrypted(cipher: string): boolean {
  return cipher.startsWith(AES_PREFIX)
}

/* =====================================================================
   需求 9：基于密码的加密 / 解密（用于站点信息加密导出 / 导入）
   - 密码通过 PBKDF2 派生为 32 字节密钥（100000 次迭代 + 16 字节随机 salt）
   - AES-256-GCM 加密，密文格式：pw:<base64(salt + iv + ciphertext + authTag)>
   - 与应用密钥加密独立，跨设备跨用户均可解密（只需密码）
   ===================================================================== */

const PW_PREFIX = 'pw:'
const PW_SALT_LENGTH = 16
const PBKDF2_ITERATIONS = 100000

/** 基于密码加密字符串 */
export function encryptWithPassword(plaintext: string, password: string): string {
  if (!plaintext) return ''
  if (!password) throw new Error('加密密码不能为空')

  const salt = randomBytes(PW_SALT_LENGTH)
  const key = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256')
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv)

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  const combined = Buffer.concat([salt, iv, encrypted, authTag])
  return PW_PREFIX + combined.toString('base64')
}

/** 基于密码解密字符串 */
export function decryptWithPassword(ciphertext: string, password: string): string {
  if (!ciphertext) return ''
  if (!password) throw new Error('解密密码不能为空')
  if (!ciphertext.startsWith(PW_PREFIX)) {
    throw new Error('不是密码加密格式（缺少 pw: 前缀）')
  }

  const combined = Buffer.from(ciphertext.slice(PW_PREFIX.length), 'base64')
  // 拆分 salt + iv + 密文 + authTag
  if (combined.length < PW_SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('密文长度异常')
  }
  const salt = combined.subarray(0, PW_SALT_LENGTH)
  const iv = combined.subarray(PW_SALT_LENGTH, PW_SALT_LENGTH + IV_LENGTH)
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH)
  const encrypted = combined.subarray(
    PW_SALT_LENGTH + IV_LENGTH,
    combined.length - AUTH_TAG_LENGTH,
  )

  const key = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
  return decrypted.toString('utf8')
}
