import { describe, expect, it } from 'vitest'
import { canonicalWebConversationUrl, stableWebConversationUrl } from './conversation-identity'

describe('web conversation routes', () => {
  it('keeps MiMo Studio chat and ultra session identities', () => {
    for (const route of ['chat', 'ultra']) {
      expect(canonicalWebConversationUrl(`https://aistudio.xiaomimimo.com/?tracking=1#/${route}/one?model=example`))
        .toBe(`https://aistudio.xiaomimimo.com/#/${route}/one`)
      expect(stableWebConversationUrl(`https://aistudio.xiaomimimo.com/#/${route}/two`))
        .not.toBe(stableWebConversationUrl(`https://aistudio.xiaomimimo.com/#/${route}/one`))
    }
  })
  it('keeps home routes as document drafts and ignores ordinary anchors', () => {
    for (const hash of ['', '#/c', '#/ultra', '#/settings', '#/chat/', '#heading'])
      expect(stableWebConversationUrl('https://aistudio.xiaomimimo.com/' + hash)).toBeUndefined()
    expect(canonicalWebConversationUrl('https://chat.deepseek.com/a/chat/s/one?model=example#heading'))
      .toBe('https://chat.deepseek.com/a/chat/s/one')
    expect(stableWebConversationUrl('https://www.qianwen.com/chat/one?pos=2')).toBe('https://www.qianwen.com/chat/one')
    expect(stableWebConversationUrl('file:///tmp/chat')).toBeUndefined()
  })
  it('retains the verified ChatGLM session query without tracking parameters', () => {
    expect(stableWebConversationUrl('https://chatglm.cn/main/alltoolsdetail')).toBeUndefined()
    expect(stableWebConversationUrl('https://www.chatglm.cn/main/alltoolsdetail?cid=')).toBeUndefined()
    expect(stableWebConversationUrl('https://chatglm.cn/main/alltoolsdetail?lang=zh&cid=one#content'))
      .toBe('https://chatglm.cn/main/alltoolsdetail?cid=one')
    expect(canonicalWebConversationUrl('https://chatglm.cn/main/alltoolsdetail?cid=two'))
      .not.toBe(canonicalWebConversationUrl('https://chatglm.cn/main/alltoolsdetail?cid=one'))
  })
})
