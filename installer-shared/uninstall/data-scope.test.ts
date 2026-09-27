import { expect, it } from 'vitest'
import { describeDataScope } from './data-scope'
import type { UninstallScanResponse } from './protocol'

function fixture(): UninstallScanResponse {
  return {
    scanId: 'scan', generatedAt: 'now', recommendedTargetId: null,
    locations: [
      { id: { token: 'old' }, path: 'E:/Apps/Alpha', displayPath: 'E:/Apps/Alpha' },
      { id: { token: 'new' }, path: 'E:/Apps/Beta', displayPath: 'E:/Apps/Beta' },
    ] as UninstallScanResponse['locations'],
    dataRoots: [{ path: 'E:/Profile/Data', source: 'caller-roaming-probe', removable: true, associatedTargetIds: [{ token: 'old' }] }],
  }
}

it('allows a single verified owner and does not include another edition profile', () => {
  const scan = fixture()
  scan.dataRoots.push({ path: 'E:/Profile/Other', source: 'caller-roaming-unverified', removable: false, associatedTargetIds: [{ token: 'other' }] })
  expect(describeDataScope(scan, ['old'])).toEqual({ roots: [scan.dataRoots[0]], issue: null })
})

it('identifies the profile and unselected installation sharing historical data', () => {
  const scan = fixture()
  scan.dataRoots[0].associatedTargetIds.push({ token: 'new' })
  const result = describeDataScope(scan, ['old'])
  expect(result.issue).toContain('E:/Profile/Data')
  expect(result.issue).toContain('E:/Apps/Beta')
  expect(result.issue).toContain('保留用户数据')
  expect(describeDataScope(scan, ['old', 'new']).issue).toBeNull()
})

it('keeps an unverified profile blocked even when all installations are selected', () => {
  const scan = fixture()
  scan.dataRoots[0].removable = false
  const result = describeDataScope(scan, ['old', 'new'])
  expect(result.issue).toContain('E:/Profile/Data')
  expect(result.issue).toContain('原登录账户')
  expect(result.issue).not.toContain('仍被未选中的安装使用')
})

it('does not authorize an unresolved sharing relationship', () => {
  const scan = fixture()
  scan.dataRoots[0].associatedTargetIds.push({ token: 'missing' })
  expect(describeDataScope(scan, ['old']).issue).toContain('未知安装位置')
})

it('leaves empty scans and unselected profiles outside the scope', () => {
  expect(describeDataScope(null, [])).toEqual({ roots: [], issue: null })
  expect(describeDataScope(fixture(), [])).toEqual({ roots: [], issue: null })
})
