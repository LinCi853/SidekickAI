import { describe, expect, it } from 'vitest'
import { cleanCapturedCodeToolbar, isAssetInterfaceImage } from './asset-presentation'

describe('captured interface presentation', () => {
  it('hides only known output site icons while retaining uploads and real small images', () => {
    const icon = { direction: 'output', mimeType: 'image/png', sourceUrl: 'https://cdn.deepseek.com/site-icons/example.com' }
    expect(isAssetInterfaceImage(icon)).toBe(true)
    expect(isAssetInterfaceImage({ ...icon, direction: 'input' })).toBe(false)
    expect(isAssetInterfaceImage({ ...icon, sourceUrl: 'https://cdn.deepseek.com/images/example.com' })).toBe(false)
    expect(isAssetInterfaceImage({ ...icon, sourceUrl: 'https://example.test/site-icons/example.com' })).toBe(false)
    expect(isAssetInterfaceImage({ ...icon, sourceUrl: 'not a URL' })).toBe(false)
  })
  it('cleans complete captured toolbars and preserves code containing the same words', () => {
    const toolbar = 'html\n\n复制\n\n下载\n\n运行\n\n```\n<p>hello</p>\n```'
    expect(cleanCapturedCodeToolbar(toolbar)).toBe('```html\n<p>hello</p>\n```')
    expect(cleanCapturedCodeToolbar(toolbar.replace('html\n\n复制', 'html复制'))).toBe('```html\n<p>hello</p>\n```')
    const literal = '````text\n' + toolbar + '\n````'
    expect(cleanCapturedCodeToolbar(literal)).toBe(literal)
    expect(cleanCapturedCodeToolbar('html\n复制\n下载\n普通说明')).toBe('html\n复制\n下载\n普通说明')
  })
})
