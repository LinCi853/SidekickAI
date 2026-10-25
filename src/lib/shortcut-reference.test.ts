/* =====================================================================
   lib/shortcut-reference.test.ts —— 页面 ID 派生与展示格式
   保证与 App.tsx 路由一致：派生错了，弹窗会展示错误页面的徽标。
   ===================================================================== */

import { describe, expect, it } from 'vitest'
import { SHORTCUT_PAGE_TITLES, formatAcc, getShortcutPageId } from './shortcut-reference'

describe('getShortcutPageId', () => {
  it('maps URL routes to page ids (aligned with App.tsx routing)', () => {
    expect(getShortcutPageId('')).toBe('main')
    expect(getShortcutPageId('?windowId=main')).toBe('main')
    expect(getShortcutPageId('?windowId=1c2f')).toBe('standalone')
    expect(getShortcutPageId('?windowId=chat')).toBe('chat')
    expect(getShortcutPageId('?windowId=1c2f&mode=chat')).toBe('chat')
    expect(getShortcutPageId('?windowId=preview')).toBe('record-indicator')
    expect(getShortcutPageId('?windowId=preview&mode=record-indicator')).toBe('record-indicator')
    expect(getShortcutPageId('?windowId=s1&mode=history')).toBe('history')
    expect(getShortcutPageId('?windowId=s1&mode=prompts')).toBe('prompts')
    expect(getShortcutPageId('?windowId=s1&mode=settings')).toBe('settings')
    expect(getShortcutPageId('?windowId=s1&mode=browser')).toBe('browser')
    expect(getShortcutPageId('?windowId=s1&mode=advanced-panel')).toBe('advanced-panel')
    expect(getShortcutPageId('?windowId=s1&mode=history-download')).toBe('history-download')
  })

  it('gives every page id a display title', () => {
    for (const [id, title] of Object.entries(SHORTCUT_PAGE_TITLES)) {
      expect(title, id).toBeTruthy()
    }
  })
})

describe('formatAcc', () => {
  it('spaces accelerator parts uniformly', () => {
    expect(formatAcc('Ctrl+Shift+Tab')).toBe('Ctrl + Shift + Tab')
    expect(formatAcc('Alt+Space')).toBe('Alt + Space')
  })
})
