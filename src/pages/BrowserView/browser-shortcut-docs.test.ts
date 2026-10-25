/* =====================================================================
   pages/BrowserView/browser-shortcut-docs.test.ts —— 快捷键说明从 defs 派生
   验证说明条目与键位实现同源：同动作多键合并、Alt+1~9 合并、
   云电脑模式下除 Ctrl+Alt+C 外全部灰显。
   ===================================================================== */

import { describe, expect, it } from 'vitest'
import { buildBrowserShortcutDocs } from './useBrowserKeyboard'

describe('buildBrowserShortcutDocs', () => {
  it('merges accelerators that share one action', () => {
    const docs = buildBrowserShortcutDocs()
    expect(docs.find((d) => d.action === '刷新当前页面')?.keys).toBe('Ctrl + R / F5')
    expect(docs.find((d) => d.action === '聚焦地址栏')?.keys).toBe('Ctrl + L / Alt + D')
  })

  it('collapses Alt+1..9 into one entry', () => {
    const docs = buildBrowserShortcutDocs()
    expect(docs.find((d) => d.action === '切换到第 N 个标签')?.keys).toBe('Alt + 1~9')
  })

  it('keeps defs declaration order and page category', () => {
    const docs = buildBrowserShortcutDocs()
    expect(docs[0].action).toBe('新建标签页')
    expect(docs.every((d) => d.category === 'page')).toBe(true)
  })

  it('greys everything except Ctrl+Alt+C in cloud PC mode', () => {
    const docs = buildBrowserShortcutDocs(true)
    const toggle = docs.find((d) => d.id === 'browser.togglecloudpc')
    expect(toggle?.disabled).toBe(false)
    expect(docs.filter((d) => d.id !== 'browser.togglecloudpc').every((d) => d.disabled)).toBe(true)
  })
})
