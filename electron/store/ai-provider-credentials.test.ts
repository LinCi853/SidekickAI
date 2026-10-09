import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ providers: [] as any[], writes: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: {}, safeStorage: {}, dialog: {} }))
vi.mock('../security/trusted-renderer.js', () => ({ assertTrustedRenderer: vi.fn() }))
vi.mock('./module-state-store.js', () => ({ createSqliteJsonStore: () => ({ get: () => state.providers,
  set: (_key: string, value: any[]) => { state.writes(value); state.providers = value } }) }))
vi.mock('../utils/permission-manager.js', () => ({ isSafeStorageAvailable: () => false,
  xorDecrypt: () => { throw new Error('Credential requires re-entry') } }))
vi.mock('../utils/app-crypto.js', () => ({ encryptString: (value: string) => `aes:${value}`, decryptString: (value: string) => value.slice(4),
  isAesEncrypted: (value: string) => value.startsWith('aes:'), encryptWithPassword: vi.fn(), decryptWithPassword: vi.fn() }))
import { AIProviderStore, ensureDefaultProviders } from './ai-provider-store.js'

beforeEach(() => { state.providers = []; state.writes.mockClear() })

it.each(['plain:legacy-key', 'xor:legacy-key'])('retains %s without decoding or erasing it and permits explicit replacement', cipher => {
  state.providers = [{ id: 'fixture', name: 'Fixture', protocol: 'openai', apiEndpoint: 'https://example.test', model: 'test', apiKeyCipher: cipher }]
  const providers = new AIProviderStore()
  ensureDefaultProviders()
  expect(state.providers[0].apiKeyCipher).toBe(cipher)
  expect(state.writes).not.toHaveBeenCalled()
  expect(providers.get('fixture')).toMatchObject({ apiKey: '', apiKeyUnavailable: true })
  providers.update('fixture', { name: 'Renamed' })
  expect(state.providers[0].apiKeyCipher).toBe(cipher)
  expect(providers.update('fixture', { apiKey: 'replacement' })).toMatchObject({ apiKey: 'replacement' })
  expect(providers.get('fixture')).not.toHaveProperty('apiKeyUnavailable')
  expect(state.providers[0]).not.toHaveProperty('apiKeyUnavailable')
})

it('leaves valid AES and empty provider credentials available', () => {
  state.providers = [{ id: 'encrypted', apiKeyCipher: 'aes:working-key' }, { id: 'empty', apiKeyCipher: '' }]
  ensureDefaultProviders()
  const providers = new AIProviderStore().list()
  expect(providers.map(provider => provider.apiKey)).toEqual(['working-key', ''])
  expect(providers.every(provider => !provider.apiKeyUnavailable)).toBe(true)
  expect(state.writes).not.toHaveBeenCalled()
})
