/* =====================================================================
   components/ShortcutsModal.test.tsx —— 快捷键速查弹窗渲染
   验证扁平列表渲染、两类纯颜色区分（is-global / is-page）、禁用灰显标记、
   页面徽标与非打开态的 aria 约定。
   ===================================================================== */

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../hooks/useEscToCloseWindow', () => ({ useEscToCloseOverlay: () => {} }))
vi.mock('../store/useShortcutDocStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/useShortcutDocStore')>()
  return {
    ...actual,
    useShortcutDocStore: (sel: (s: { sources: Record<string, unknown> }) => unknown) =>
      sel({
        sources: {
          mock: [
            {
              id: 'global.toggleMainWindow',
              keys: 'Alt + Space',
              action: '呼出/隐藏主窗口',
              category: 'global',
            },
            {
              id: 'settings.window-esc',
              keys: 'Esc',
              action: '关闭窗口（浮窗打开时先关闭浮窗）',
              category: 'page',
              disabled: true,
            },
            {
              id: 'help.toggle',
              keys: '` / ~ / ?',
              action: '呼出 / 关闭快捷键说明',
              category: 'page',
            },
          ],
        },
      }),
  }
})

import ShortcutsModal from './ShortcutsModal'

describe('ShortcutsModal', () => {
  it('renders a flat list with color-only categories and hides disabled entries', () => {
    const html = renderToStaticMarkup(<ShortcutsModal open onClose={() => {}} pageId="settings" />)
    expect(html).toContain('is-global')
    expect(html).toContain('is-page')
    expect(html).toContain('data-category="global"')
    expect(html).toContain('data-category="page"')
    expect(html).toContain('Alt + Space')
    expect(html).toContain('呼出 / 关闭快捷键说明')
    // 已禁用条目不进速查
    expect(html).not.toContain('is-disabled')
    expect(html).not.toContain('（已禁用）')
    expect(html).not.toContain('Esc<')
    // 全局条目排前（颜色即分类，无分类行）
    expect(html.indexOf('Alt + Space')).toBeLessThan(html.indexOf('呼出 / 关闭快捷键说明'))
  })

  it('marks the overlay hidden while closed and shows the page badge', () => {
    const html = renderToStaticMarkup(
      <ShortcutsModal open={false} onClose={() => {}} pageId="main" />,
    )
    expect(html).toContain('aria-hidden="true"')
    expect(html).not.toContain('is-open')
    expect(html).toContain('主窗口')
  })
})
