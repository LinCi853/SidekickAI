import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ providers: [] as any[], writes: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: {}, safeStorage: {}, dialog: {} }))
vi.mock('../security/trusted-renderer.js', () => ({ assertTrustedRenderer: vi.fn() }))
vi.mock('./module-state-store.js', () => ({ createSqliteJsonStore: ({ tableName }: { tableName: string }) => ({
  get: (key: string) => tableName === 'app_key' && key === 'key' ? Buffer.alloc(32, 7).toString('base64') : state.providers,
  set: (_key: string, value: any[]) => { state.writes(value); state.providers = value },
}) }))
vi.mock('../utils/permission-manager.js', () => ({ isSafeStorageAvailable: () => false,
  xorDecrypt: () => { throw new Error('Credential requires re-entry') } }))
import { AIProviderStore } from './ai-provider-store.js'
import { decryptWithPassword, encryptString } from '../utils/app-crypto.js'

const password = 'controlled-export-password'
const provider = (apiKeyCipher: string, id = 'fixture') => ({ id, name: 'Fixture', protocol: 'openai',
  apiEndpoint: 'https://example.test', model: 'fixture-model', apiKeyCipher })

beforeEach(() => { state.providers = []; state.writes.mockClear() })

it.each(['plain:legacy-key', 'xor:legacy-key', 'unavailable-device-value', 'aes:' + Buffer.alloc(32).toString('base64')])('fails an export with unavailable credentials without replacing a matching import target: %s', cipher => {
  const providers = new AIProviderStore()
  state.providers = [provider(cipher)]
  const source = structuredClone(state.providers)
  let exported: string | undefined
  let error: unknown
  try { exported = providers.exportEncrypted(password) } catch (failure) { error = failure }
  const retainedSource = structuredClone(state.providers)
  const target = provider(encryptString('valid-target-key'))
  state.providers = [structuredClone(target)]
  if (exported !== undefined) providers.importEncrypted(exported, password)
  expect(state.providers[0].apiKeyCipher).toBe(target.apiKeyCipher)
  expect(retainedSource).toEqual(source)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toMatch(/重新录入/)
  expect(exported).toBeUndefined()
  expect(state.writes).not.toHaveBeenCalled()
})

it('round trips valid and intentionally empty credentials through password encryption', () => {
  const providers = new AIProviderStore()
  state.providers = [provider(encryptString('working-key')), provider('', 'empty')]
  const source = structuredClone(state.providers)
  const exported = providers.exportEncrypted(password)
  expect(exported).toMatch(/^pw:/)
  expect(exported).not.toContain('working-key')
  expect(state.providers).toEqual(source)
  expect(state.writes).not.toHaveBeenCalled()
  state.providers = []
  expect(providers.importEncrypted(exported, password)).toEqual({ ok: true })
  expect(providers.list().map(value => ({ id: value.id, apiKey: value.apiKey }))).toEqual([
    { id: 'fixture', apiKey: 'working-key' }, { id: 'empty', apiKey: '' },
  ])
})

it('exports only selected usable providers and retains an unavailable unselected record', () => {
  const providers = new AIProviderStore()
  state.providers = [provider(encryptString('selected-key')), provider('plain:unavailable-key', 'unselected')]
  const source = structuredClone(state.providers)
  const exported = providers.exportEncrypted(password, ['fixture'])
  const payload = JSON.parse(decryptWithPassword(exported, password))
  expect(payload.providers).toHaveLength(1)
  expect(payload.providers[0]).toMatchObject({ id: 'fixture', apiKey: 'selected-key' })
  expect(state.providers).toEqual(source)
  expect(state.writes).not.toHaveBeenCalled()
})
