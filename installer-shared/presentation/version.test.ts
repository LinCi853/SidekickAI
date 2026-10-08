import { expect, it } from 'vitest'
import { formatVersion } from './version'

it.each([
  ['0.1.5+20261007.007', '0.1.5'],
  ['0.1.6', '0.1.6'],
  ['0.1.6-rc.1+20261007.001', '0.1.6-rc.1+20261007.001'],
  ['版本未知', '版本未知'],
  ['01.1.5+001', '01.1.5+001'],
  ['0.1.5\n', '0.1.5\n'],
])('formats %s without changing non-stable identities', (version, expected) => {
  expect(formatVersion(version)).toBe(expected)
})
