import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deferred, settleHooks } from '../../hooks/draft-hook-test-harness'
import type { AssetAttachment, AssetAttachmentPreview } from '../../../electron/shared/ai-assets.types'
const harness = await vi.hoisted(async () => (await import('../../hooks/draft-hook-test-harness')).createHookHarness())
const api = vi.hoisted(() => ({ previewAttachment: vi.fn(), copyText: vi.fn() }))
vi.mock('react', async () => ({ ...await vi.importActual('react'), ...harness.react }))
vi.mock('../../lib/electron-api/core', () => ({ requireElectron: () => ({ aiAssets: api }) }))
vi.mock('../../components/ui', () => ({ IconButton: 'button', Modal: 'modal' }))
import AssetFilePreview from './AssetFilePreview'

const item = { id: 'file', name: 'fixture.txt', sha256: 'hash' } as AssetAttachment
function elements(node: any): any[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!node?.props) return []
  return [node, ...elements(node.props.children)]
}
beforeEach(() => { harness.reset(); vi.resetAllMocks(); vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {}) })
afterEach(async () => { harness.unmount(); await settleHooks(); vi.restoreAllMocks() })
describe('attachment preview lifecycle', () => {
  it('renders HTML as a literal text node and copies only the displayed text', async () => {
    const text = '<script>window.fixtureExecuted=true</script>'
    api.previewAttachment.mockResolvedValue({ ok: true, kind: 'text', text, truncated: false })
    const view = harness.mount(() => AssetFilePreview({ item, onClose: vi.fn(), onAction: operation => { void operation() } }))
    await settleHooks()
    expect(elements(view.current).find(element => element.type === 'pre')!.props.children).toBe(text)
    expect(elements(view.current).some(element => element.props.dangerouslySetInnerHTML)).toBe(false)
    elements(view.current).find(element => element.props['aria-label'] === '复制文本')!.props.onClick()
    expect(api.copyText).toHaveBeenCalledWith(text)
  })
  it('revokes media on reload and close', async () => {
    api.previewAttachment.mockResolvedValue({ ok: true, kind: 'image', mimeType: 'image/png', bytes: new Uint8Array([1, 2]) })
    const view = harness.mount(() => AssetFilePreview({ item, onClose: vi.fn(), onAction: vi.fn() }))
    await settleHooks(); expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    elements(view.current).find(element => element.props['aria-label'] === '重新加载预览')!.props.onClick()
    await settleHooks(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fixture')
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2)
    harness.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
  })
  it('ignores late media responses after closing', async () => {
    const response = deferred<AssetAttachmentPreview>()
    api.previewAttachment.mockReturnValue(response.promise)
    harness.mount(() => AssetFilePreview({ item, onClose: vi.fn(), onAction: vi.fn() }))
    harness.unmount(); response.resolve({ ok: true, kind: 'pdf', mimeType: 'application/pdf', bytes: new Uint8Array([1]) })
    await settleHooks(); expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
})
