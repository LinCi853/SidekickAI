import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { editionSessionEndpoint } from '../packages/desktop-common/edition-session'
import { applicationSessionIntent, installationReservationPath, readInstallationReservation, type InstallationReservation } from '../packages/desktop-common/installation-reservation'

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), stat: vi.fn(), read: vi.fn() }))
vi.mock('../packages/desktop-common/application-process', () => ({ applicationProcessOperation: mocks.inspect, prepareEditionSession: vi.fn() }))
vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, default: { ...original, statSync: mocks.stat, readFileSync: mocks.read } }
})
const endpoint = editionSessionEndpoint(randomUUID())
let reservation: InstallationReservation
beforeEach(() => {
  vi.stubEnv('LOCALAPPDATA', 'E:/fixture/local')
  reservation = { protocol: 1, requestId: 'a'.repeat(64), executable: 'E:/fixture/concept/SidekickAI.exe', edition: 'concept', version: '0.1.6', pid: 100,
    ownerExecutable: 'E:/fixture/setup.exe', ownerStarted: '123', sid: 'fixture-user', session: 1, expiresAt: Date.now() + 60000 }
  mocks.stat.mockReturnValue({ isFile: () => true, size: 1000 })
  mocks.read.mockImplementation(() => JSON.stringify(reservation))
  mocks.inspect.mockResolvedValue({ executable: reservation.ownerExecutable, started: reservation.ownerStarted, sid: reservation.sid, session: reservation.session })
})
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

it('accepts installation intent only with a complete request nonce', () => {
  vi.stubEnv('SIDEKICK_APPLICATION_INTENT', 'installation')
  vi.stubEnv('SIDEKICK_APPLICATION_REQUEST_ID', 'a'.repeat(64))
  expect(applicationSessionIntent()).toEqual({ intent: 'installation', requestId: 'a'.repeat(64) })
  vi.stubEnv('SIDEKICK_APPLICATION_REQUEST_ID', 'replayed')
  expect(applicationSessionIntent()).toEqual({ intent: 'ordinary' })
})
it('places independent endpoint reservations in independent directories', () => {
  expect(installationReservationPath(endpoint)).not.toBe(installationReservationPath(editionSessionEndpoint(randomUUID())))
  expect(() => installationReservationPath('unrelated-pipe')).toThrow()
})
it.runIf(process.platform === 'win32')('accepts a reservation bound to its live ordinary controller', async () => {
  expect(await readInstallationReservation(endpoint)).toEqual(reservation)
})
it('ignores expired or implausibly long reservations without inspecting a process', async () => {
  for (const expiresAt of [Date.now() - 1, Date.now() + 1000000]) {
    reservation.expiresAt = expiresAt
    expect(await readInstallationReservation(endpoint)).toBeNull()
  }
  expect(mocks.inspect).not.toHaveBeenCalled()
})
it.runIf(process.platform === 'win32')('rejects PID reuse, another account, session or executable', async () => {
  for (const difference of [{ started: '456' }, { sid: 'other-user' }, { session: 2 }, { executable: 'E:/unrelated/setup.exe' }]) {
    mocks.inspect.mockResolvedValue({ executable: reservation.ownerExecutable, started: reservation.ownerStarted, sid: reservation.sid, session: reservation.session, ...difference })
    expect(await readInstallationReservation(endpoint)).toBeNull()
  }
})
it('ignores oversized or malformed reservation records', async () => {
  mocks.stat.mockReturnValue({ isFile: () => true, size: 4097 })
  expect(await readInstallationReservation(endpoint)).toBeNull()
  mocks.stat.mockReturnValue({ isFile: () => true, size: 100 })
  mocks.read.mockReturnValue('{invalid')
  expect(await readInstallationReservation(endpoint)).toBeNull()
})
it('rejects missing, object, string, non-finite or fractional expiry values', async () => {
  for (const expiresAt of [undefined, {}, String(Date.now() + 60000), Infinity, NaN, Date.now() + 0.5]) {
    mocks.read.mockReturnValue(JSON.stringify({ ...reservation, expiresAt }))
    expect(await readInstallationReservation(endpoint)).toBeNull()
  }
  expect(mocks.inspect).not.toHaveBeenCalled()
})
