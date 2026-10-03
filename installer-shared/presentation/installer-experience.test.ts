import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import StepWelcome from '../../installer-tauri/src/steps/StepWelcome'
import StepDone from '../../installer-tauri/src/steps/StepDone'
import type { InstallerInfo, ScanResult } from '../../installer-tauri/src/global'

it.each([['概念版', '社区版'], ['社区版', '概念版']])('shows the other edition before installing %s', (current, other) => {
  const scan = { locations: [], recommendedDir: 'E:/Apps/current', residualHint: '', fixedDrives: [], otherEditions: [{ label: other, edition: 'other', path: 'E:/Apps/other', version: '0.1.0-beta.5', arch: 'x64' }], otherEditionsWarning: '' } as ScanResult
  const html = renderToStaticMarkup(React.createElement(StepWelcome, { actionName: '安装', mode: 'install', setMode: vi.fn(), scan, info: { editionLabel: current, version: '0.1.0-beta.5' } as InstallerInfo }))
  expect(html).toContain(current)
  expect(html).toContain(other)
  expect(html).toContain('E:/Apps/other')
  expect(html).toContain('分别安装')
  expect(html).toContain('卸载')
  expect(html).not.toContain('修复安装')
})

it('surfaces incomplete cross-edition discovery', () => {
  const scan = { locations: [], otherEditions: [], otherEditionsWarning: '无法完整检查已有安装' } as unknown as ScanResult
  const html = renderToStaticMarkup(React.createElement(StepWelcome, { actionName: '安装', mode: 'install', setMode: vi.fn(), scan, info: null }))
  expect(html).toContain('无法完整检查已有安装')
})

it.each(['概念版', '社区版'])('shows the installed %s without an automatic launch choice', editionLabel => {
  const props = { actionName: '安装', mode: 'install' as const, finalDir: 'E:/Apps/actual', installDir: 'E:/Apps/requested', residualNote: '', closeBanner: '', info: { editionLabel, version: '0.1.0-beta.5' } as InstallerInfo, completionIntent: 'close' as const }
  const html = renderToStaticMarkup(React.createElement(StepDone, props))
  expect(html).toContain(editionLabel)
  expect(html).toContain('0.1.0-beta.5')
  expect(html).toContain('E:/Apps/actual')
  expect(html).not.toContain('E:/Apps/requested')
  expect(html).not.toContain('type="checkbox"')
  expect(html).not.toContain('完成后打开')
})
