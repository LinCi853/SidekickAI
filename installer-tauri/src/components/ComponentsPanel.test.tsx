import { expect, it, vi } from 'vitest'
import { elements } from '../../../src/test/hook-harness'
import { installationPolicy } from '../../../installer-shared/edition-policy'
import type { InstallerInfo } from '../global'
import ComponentsPanel from './ComponentsPanel'

it('allows selecting and clearing an optional installation component', () => {
  const toggleFeature = vi.fn()
  const info = { features: [{ id: 'optional-tool', name: '可选工具', description: '工具', installRequired: true, required: false }] } as InstallerInfo
  for (const selected of [false, true]) {
    const page = ComponentsPanel({ info, features: { 'optional-tool': selected }, toggleFeature, cloudNotice: '', cloudAssets: [] })
    const row = elements(page).find(element => element.props.className?.includes('check-row--rich'))!
    expect(row.props.className).not.toContain('locked')
    const checkbox = elements(row).find(element => element.props.className?.startsWith('checkbox'))!
    expect(checkbox.props.className.includes('checkbox--checked')).toBe(selected)
    row.props.onClick()
  }
  expect(toggleFeature.mock.calls).toEqual([['optional-tool'], ['optional-tool']])
})

it('does not invent a component when the edition metadata omits it', () => {
  const page = ComponentsPanel({ info: { features: [] } as unknown as InstallerInfo, features: {}, toggleFeature: vi.fn(), cloudNotice: '', cloudAssets: [] })
  expect(elements(page).some(element => element.props.className?.includes('check-row--rich'))).toBe(false)
  expect(elements(page).some(element => element.props.children === installationPolicy.contentDescription)).toBe(true)
})
