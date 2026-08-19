import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock electron with hoisted variables
const mockSafeStorage = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
}))

vi.mock('electron', () => ({
  dialog: {
    showMessageBoxSync: vi.fn(() => 0),
  },
  shell: {
    openExternal: vi.fn(),
  },
  safeStorage: mockSafeStorage,
  systemPreferences: {
    isTrustedAccessibilityClient: vi.fn(() => true),
  },
}))

describe('permission-manager', () => {
  let permissionManager: typeof import('./permission-manager.js')

  beforeEach(async () => {
    vi.resetModules()
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true)
    permissionManager = await import('./permission-manager.js')
  })

  describe('checkAccessibilityPermission', () => {
    it('should return true on current platform (non-darwin)', () => {
      expect(permissionManager.checkAccessibilityPermission()).toBe(true)
    })
  })

  describe('getStorageBackend', () => {
    it('should return a valid backend', () => {
      const backend = permissionManager.getStorageBackend()
      expect(['keychain', 'libsecret', 'dpapi', 'fallback']).toContain(backend)
    })
  })

  describe('isSafeStorageAvailable', () => {
    it('should return true when safeStorage is available', () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(true)
      expect(permissionManager.isSafeStorageAvailable()).toBe(true)
    })

    it('should return false when safeStorage is not available', () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(false)
      expect(permissionManager.isSafeStorageAvailable()).toBe(false)
    })

    it('should return false when safeStorage throws', () => {
      mockSafeStorage.isEncryptionAvailable.mockImplementation(() => {
        throw new Error('not available')
      })
      expect(permissionManager.isSafeStorageAvailable()).toBe(false)
    })
  })

  describe('xorDecrypt', () => {
    it('should decrypt xor: prefixed ciphertext', () => {
      const key = Buffer.from('ai-window-xor-fallback-v1', 'utf8')
      const plain = Buffer.from('test', 'utf8')
      const encrypted = Buffer.alloc(plain.length)
      for (let i = 0; i < plain.length; i++) {
        encrypted[i] = plain[i]! ^ key[i % key.length]!
      }
      const cipher = 'xor:' + encrypted.toString('base64')

      expect(permissionManager.xorDecrypt(cipher)).toBe('test')
    })

    it('should throw for non-xor: prefix', () => {
      expect(() => permissionManager.xorDecrypt('aes:abc')).toThrow('不是 XOR 降级密文')
    })

    it('should throw for plain text', () => {
      expect(() => permissionManager.xorDecrypt('plain text')).toThrow('不是 XOR 降级密文')
    })
  })
})
