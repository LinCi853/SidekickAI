import { describe, expect, it } from 'vitest'
import { buildShadowStyleScript } from './webview'

describe('buildShadowStyleScript', () => {
  const script = buildShadowStyleScript()

  it('follows the preferred color scheme instead of forcing light', () => {
    expect(script).toContain("window.matchMedia('(prefers-color-scheme: dark)')")
    expect(script).toContain("mq.matches ? 'dark' : 'light'")
    expect(script).toContain("mq.addEventListener('change', applyScheme)")
  })

  it('keeps the shadow and scrollbar cleanup styles', () => {
    expect(script).toContain("__ai_no_shadow__")
    expect(script).toContain('box-shadow: none !important')
    expect(script).toContain('::-webkit-scrollbar { width: 0 !important')
  })

  it('applies the scheme once before appending the style', () => {
    const applyIndex = script.indexOf('applyScheme();')
    const appendIndex = script.indexOf("document.head.appendChild(s);")
    expect(applyIndex).toBeGreaterThan(-1)
    expect(appendIndex).toBeGreaterThan(applyIndex)
  })
})
