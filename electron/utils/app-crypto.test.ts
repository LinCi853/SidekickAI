import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock electron-store
vi.mock('electron-store', () => {
  return {
    default: class MockStore {
      private data: Record<string, unknown> = {}
      get(key: string) { return this.data[key] }
      set(key: string | Record<string, unknown>, value?: unknown) {
        if (typeof key === 'object') {
          Object.assign(this.data, key)
        } else {
          this.data[key] = value
        }
      }
    },
  }
})

// Mock module-state-store (app-crypto imports createSqliteJsonStore from here)
vi.mock('../store/module-state-store.js', () => {
  const stores = new Map<string, Record<string, unknown>>()
  return {
    createSqliteJsonStore: vi.fn((opts: { tableName: string }) => {
      if (!stores.has(opts.tableName)) stores.set(opts.tableName, {})
      const data = stores.get(opts.tableName)!
      return {
        get: (key: string) => data[key],
        set: (key: string, value: unknown) => { data[key] = value },
        delete: (key: string) => { delete data[key] },
        has: (key: string) => key in data,
      }
    }),
  }
})

describe('app-crypto', () => {
  let appCrypto: typeof import('./app-crypto.js')

  beforeEach(async () => {
    vi.resetModules()
    appCrypto = await import('./app-crypto.js')
  })

  describe('encryptString / decryptString', () => {
    it('should encrypt and decrypt a string', () => {
      const plain = 'Hello, World!'
      const encrypted = appCrypto.encryptString(plain)

      expect(encrypted).not.toBe(plain)
      expect(appCrypto.isAesEncrypted(encrypted)).toBe(true)

      const decrypted = appCrypto.decryptString(encrypted)
      expect(decrypted).toBe(plain)
    })

    it('should return empty string for empty input', () => {
      expect(appCrypto.encryptString('')).toBe('')
      expect(appCrypto.decryptString('')).toBe('')
    })

    it('should produce different ciphertext for same plaintext', () => {
      const plain = 'test'
      const enc1 = appCrypto.encryptString(plain)
      const enc2 = appCrypto.encryptString(plain)

      // IV is random, so ciphertext should differ
      expect(enc1).not.toBe(enc2)

      // But both should decrypt to same value
      expect(appCrypto.decryptString(enc1)).toBe(plain)
      expect(appCrypto.decryptString(enc2)).toBe(plain)
    })

    it('should throw for invalid ciphertext', () => {
      expect(() => appCrypto.decryptString('invalid')).toThrow('不是 AES 加密格式')
    })

    it('should throw for tampered ciphertext', () => {
      const encrypted = appCrypto.encryptString('test')
      // Tamper with the base64 content
      const tampered = encrypted.slice(0, -2) + 'XX'
      expect(() => appCrypto.decryptString(tampered)).toThrow()
    })
  })

  describe('isAesEncrypted', () => {
    it('should return true for aes: prefix', () => {
      expect(appCrypto.isAesEncrypted('aes:abc123')).toBe(true)
    })

    it('should return false for other strings', () => {
      expect(appCrypto.isAesEncrypted('plain text')).toBe(false)
      expect(appCrypto.isAesEncrypted('')).toBe(false)
      expect(appCrypto.isAesEncrypted('pw:abc')).toBe(false)
    })
  })

  describe('encryptWithPassword / decryptWithPassword', () => {
    it('should encrypt and decrypt with password', () => {
      const plain = 'Secret data'
      const password = 'my-password'

      const encrypted = appCrypto.encryptWithPassword(plain, password)
      expect(encrypted).not.toBe(plain)
      expect(encrypted.startsWith('pw:')).toBe(true)

      const decrypted = appCrypto.decryptWithPassword(encrypted, password)
      expect(decrypted).toBe(plain)
    })

    it('should return empty string for empty plaintext', () => {
      expect(appCrypto.encryptWithPassword('', 'password')).toBe('')
      expect(appCrypto.decryptWithPassword('', 'password')).toBe('')
    })

    it('should throw for empty password on encrypt', () => {
      expect(() => appCrypto.encryptWithPassword('test', '')).toThrow('加密密码不能为空')
    })

    it('should throw for empty password on decrypt', () => {
      expect(() => appCrypto.decryptWithPassword('pw:abc', '')).toThrow('解密密码不能为空')
    })

    it('should throw for wrong password', () => {
      const encrypted = appCrypto.encryptWithPassword('test', 'correct-password')
      expect(() => appCrypto.decryptWithPassword(encrypted, 'wrong-password')).toThrow()
    })

    it('should throw for non-pw: prefix', () => {
      expect(() => appCrypto.decryptWithPassword('aes:abc', 'password')).toThrow('不是密码加密格式')
    })
  })
})
