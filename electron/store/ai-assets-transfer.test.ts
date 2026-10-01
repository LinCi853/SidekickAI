import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '' } }))
import { ChatStore } from './chat-store'

describe('AI asset interchange', () => {
  it('round trips repeated turns, reasoning, retained revisions and attachment provenance', () => {
    const store = new ChatStore(':memory:')
    try {
      const conversation = store.createConversation('api', 'api', 'Repeated turns')
      store.assets.capture(conversation.id, { key: 'u1', role: 'user', content: '好 😀' })
      store.assets.capture(conversation.id, { key: 'u2', role: 'user', content: '好 😀' })
      store.assets.capture(conversation.id, { key: 'a1', role: 'assistant', content: 'original', reasoning: 'thinking' })
      store.assets.capture(conversation.id, { key: 'a1', role: 'assistant', content: '', status: 'withdrawn' })
      const file = store.assets.beginAttachment({ id: 'api', type: 'api' }, {
        conversationKey: conversation.id, title: '', messageKey: 'a1', externalKey: 'attachment', name: 'image.png',
        mimeType: 'image/png', direction: 'output', sourceUrl: 'https://fixture/image.png',
      }, conversation.id)
      store.assets.attachmentSaved(file.id, 'a'.repeat(64), 33, false)
      const exported = store.exportConversation(conversation.id, 'json')
      const copy = store.importConversation('json', exported, 'imported')
      expect(store.listMessages(copy.id).filter(m => m.role === 'user')).toHaveLength(2)
      expect(store.assets.details(copy.id).at(-1)).toMatchObject({ status: 'withdrawn', reasoning: 'thinking', revisions: [expect.objectContaining({ content: 'original' })] })
      expect(store.assets.attachments(copy.id)[0]).toMatchObject({ name: 'image.png', sourceId: 'api', status: 'pending', sha256: 'a'.repeat(64) })
      expect(store.assets.attachments(copy.id)[0].messageId).toBe(store.listMessages(copy.id).at(-1)!.id)
      expect(store.assets.usage('api').totalCharacters).toBe(store.assets.usage('imported').totalCharacters)
      expect(store.exportConversation(conversation.id, 'md')).toContain('thinking')
      expect(store.exportConversation(conversation.id, 'md')).toContain('image.png')
    } finally { store.close() }
  })
  it('rolls back malformed asset imports and preserves older JSON import compatibility', () => {
    const store = new ChatStore(':memory:')
    try {
      expect(() => store.importConversation('json', JSON.stringify({ title: 'invalid', messages: [{ role: 'user', content: 'x' }], attachments: [{ name: 1 }] }), 'imported')).toThrow()
      expect(store.listConversations()).toHaveLength(0)
      const imported = store.importConversation('json', JSON.stringify({ title: 'old', messages: [{ role: 'user', content: 'x' }, { role: 'user', content: 'x' }] }), 'imported')
      expect(store.listMessages(imported.id)).toHaveLength(2)
    } finally { store.close() }
  })
})
