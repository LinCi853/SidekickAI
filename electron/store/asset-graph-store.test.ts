import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '' } }))
import { ChatStore } from './chat-store'
import type { AssetObservation, AssetObservedMessage } from '../shared/ai-assets.types'
const source = { id: 'account-a', type: 'webview' as const }
const message = (key: string, content: string, versionKey = ''): AssetObservedMessage => ({ key, content, role: key.startsWith('u') ? 'user' : 'assistant', versionKey, status: 'complete' })
const snapshot = (messages: AssetObservedMessage[], extra: Partial<AssetObservation> = {}): AssetObservation => ({ conversationKey: '/chat/1', title: 'Archive', messages, snapshot: true, completePath: true, ...extra })
function graph(store: ChatStore, id: string) { return store.assets.graph.view(id, store.listMessages(id)) }
describe('asset conversation paths', () => {
  it('continues A after B and isolates identical sessions across accounts', () => {
    const store = new ChatStore(':memory:')
    try {
      const a = store.assets.observe(source, snapshot([message('u1', 'same'), message('a1', 'first')]))
      store.assets.observe(source, snapshot([message('u1', 'same')], { conversationKey: '/chat/2' }))
      store.assets.observe(source, snapshot([message('u1', 'same'), message('a1', 'first'), message('u2', 'same')]))
      store.assets.observe({ ...source, id: 'account-b' }, snapshot([message('u1', 'same')]))
      expect(store.listConversations()).toHaveLength(3)
      expect(graph(store, a.conversationId).nodes.filter(node => node.role === 'user')).toHaveLength(2)
      expect(store.assets.usage(source.id).inputCharacters).toBe(12)
    } finally { store.close() }
  })
  it('continues legacy URL aliases across transient parameters while separating website origins', () => {
    const store = new ChatStore(':memory:')
    try {
      const legacy = store.assets.observe(source, snapshot([message('u1', 'old input')], { conversationKey: '/chat/1?panel=old', url: 'https://fixture.test/chat/1?panel=old#focus' }))
      const current = store.assets.observe(source, snapshot([message('u1', 'old input')], { conversationKey: 'https://fixture.test/chat/1', url: 'https://fixture.test/chat/1?panel=new' }))
      expect(current.conversationId).toBe(legacy.conversationId)
      const other = store.assets.observe(source, snapshot([message('u1', 'other input')], { conversationKey: 'https://other.test/chat/1', url: 'https://other.test/chat/1' }))
      expect(other.conversationId).not.toBe(current.conversationId)
    } finally { store.close() }
  })
  it('associates each branch original with its observed source path despite a different local selection', () => {
    const store = new ChatStore(':memory:')
    try {
      const { conversationId: id } = store.assets.observe(source, snapshot([message('u1', 'first', '1'), message('a1', 'one', '1')]))
      const first = store.assets.beginAttachment(source, { conversationKey: '/chat/1', messageKey: 'a1', externalKey: 'first-file', title: 'Archive', mimeType: 'text/plain', name: 'first.txt', direction: 'output' })
      const selected = graph(store, id).path[0]
      store.assets.graph.select(id, selected)
      store.assets.observe(source, snapshot([message('u1', 'second', '2'), message('a1', 'two', '2')]))
      store.assets.graph.select(id, selected)
      const second = store.assets.beginAttachment(source, { conversationKey: '/chat/1', messageKey: 'a1', externalKey: 'second-file', title: 'Archive', mimeType: 'text/plain', name: 'second.txt', direction: 'output' })
      expect(first.messageId).not.toBe(second.messageId)
      expect(graph(store, id).nodes.find(node => node.id === second.messageId)?.content).toBe('two')
      expect(graph(store, id).nodes.find(node => node.id === first.messageId)?.content).toBe('one')
    } finally { store.close() }
  })
  it('switches an entire suffix while sharing ancestors and retaining virtualized messages', () => {
    const store = new ChatStore(':memory:')
    try {
      const prefix = [message('u0', 'shared input'), message('a0', 'shared answer')]
      const first = [...prefix, { ...message('u1', 'branch one', '1'), branchIndex: 1, branchCount: 2 }, message('a1', 'one answer', '1'), message('u2', 'one next'), message('a2', 'one suffix')]
      const { conversationId: id } = store.assets.observe(source, snapshot(first))
      const second = [...prefix, { ...message('u1', 'branch two', '2'), branchIndex: 2, branchCount: 2 }, message('a1', 'two answer', '2'), message('u2', 'two next'), message('a2', 'two suffix')]
      store.assets.observe(source, snapshot(second))
      const both = graph(store, id)
      expect(both.nodes).toHaveLength(10)
      expect(both.path.map(key => both.nodes.find(node => node.id === key)!.content).at(-1)).toBe('two suffix')
      const branch = both.nodes.find(node => node.content === 'branch one')!
      store.assets.graph.select(id, branch.id)
      const selected = graph(store, id)
      expect(selected.path.map(key => selected.nodes.find(node => node.id === key)!.content).slice(-2)).toEqual(['one next', 'one suffix'])
      const usage = store.assets.usage(undefined, id)
      store.assets.observe(source, snapshot([message('a2', 'two suffix')], { completePath: false }))
      expect(graph(store, id).path).toEqual(selected.path)
      expect(store.assets.usage(undefined, id)).toEqual(usage)
      expect(store.assets.details(id).every(detail => detail.status === 'complete')).toBe(true)
    } finally { store.close() }
  })
  it('retains gaps without inventing branches and upgrades a version counter without recounting the message', () => {
    const store = new ChatStore(':memory:')
    try {
      const initial = [message('u0', 'prefix'), message('a0', 'answer'), message('u1', 'followup'), message('a1', 'suffix')]
      const { conversationId: id } = store.assets.observe(source, snapshot(initial))
      const text = store.assets.usage(undefined, id)
      store.assets.observe(source, snapshot([initial[0], initial[3]]))
      store.assets.observe(source, snapshot([initial[2], { ...initial[3], versionKey: '1', branchIndex: 1, branchCount: 2 }]))
      const retained = graph(store, id)
      expect(retained.nodes).toHaveLength(4)
      expect(retained.path).toHaveLength(4)
      expect(store.assets.usage(undefined, id)).toEqual(text)
      store.assets.observe(source, snapshot([initial[2], { ...initial[3], versionKey: '1', branchIndex: 1, branchCount: 2 }, message('u2', 'new input')]))
      expect(graph(store, id).path).toHaveLength(5)
      expect(graph(store, id).nodes).toHaveLength(5)
    } finally { store.close() }
  })
  it('does not count known text again when its receive status changes and preserves deletion markers after removing their parent', () => {
    const store = new ChatStore(':memory:')
    try {
      const first = [message('u0', 'prefix'), message('a0', 'old answer'), message('u1', 'child')]
      const { conversationId: id } = store.assets.observe(source, snapshot(first))
      store.assets.observe(source, snapshot([first[0], { ...first[1], content: 'new answer', status: 'stopped' }, first[2]]))
      const usage = store.assets.usage(undefined, id)
      store.assets.observe(source, snapshot([first[0], { ...first[1], status: 'failed' }, first[2]]))
      expect(store.assets.usage(undefined, id)).toEqual(usage)
      const value = graph(store, id)
      store.deleteMessage(value.nodes.find(node => node.sourceKey === 'u1')!.id)
      store.deleteMessage(value.nodes.find(node => node.sourceKey === 'a0')!.id)
      store.assets.observe(source, snapshot(first))
      expect(store.listMessages(id)).toHaveLength(1)
      const exported = store.exportConversation(id, 'json')
      expect(graph(store, store.importConversation('json', exported, 'imported').id).nodes).toHaveLength(1)
    } finally { store.close() }
  })
  it('keeps suffix identities separate when a version changes in a partial snapshot', () => {
    const store = new ChatStore(':memory:')
    try {
      const prefix = [message('u0', 'prefix'), message('a0', 'answer')]
      const first = [...prefix, message('u1', 'first', '1'), message('a1', 'reply', '1'), message('u2', 'same followup'), message('a2', 'first suffix')]
      const { conversationId: id } = store.assets.observe(source, snapshot(first))
      store.assets.observe(source, snapshot([message('u1', 'second', '2'), message('a1', 'other reply', '2'), message('u2', 'same followup'), message('a2', 'second suffix')], { completePath: false }))
      const value = graph(store, id)
      expect(value.nodes).toHaveLength(10)
      expect(value.path.map(key => value.nodes.find(node => node.id === key)!.content)).toEqual(['prefix', 'answer', 'second', 'other reply', 'same followup', 'second suffix'])
      store.assets.graph.select(id, value.nodes.find(node => node.content === 'first')!.id)
      expect(graph(store, id).path.map(key => value.nodes.find(node => node.id === key)!.content).at(-1)).toBe('first suffix')
    } finally { store.close() }
  })
  it('keeps local edits through capture updates and excludes locally deleted records', () => {
    const store = new ChatStore(':memory:')
    try {
      const { conversationId: id } = store.assets.observe(source, snapshot([message('u1', 'input'), message('a1', 'answer')]))
      const output = graph(store, id).nodes.find(node => node.role === 'assistant')!
      store.updateMessage(output.id, { content: 'curated' })
      store.assets.observe(source, snapshot([message('u1', 'input'), message('a1', 'updated')]))
      expect(store.listMessages(id).find(node => node.id === output.id)?.content).toBe('curated')
      expect(store.assets.details(id).find(detail => detail.messageId === output.id)?.revisions.some(revision => revision.content === 'answer')).toBe(true)
      store.assets.renameConversation(id, 'My title')
      store.assets.observe(source, snapshot([message('u1', 'input'), message('a1', 'updated')]))
      expect(store.listConversations()[0].title).toBe('My title')
      store.deleteMessage(output.id)
      store.assets.observe(source, snapshot([message('u1', 'input'), message('a1', 'updated')]))
      expect(store.listMessages(id)).toHaveLength(1)
      store.deleteConversation(id)
      expect(store.assets.observe(source, snapshot([message('u1', 'input')]))).toMatchObject({ suppressed: true })
      expect(store.listConversations()).toHaveLength(0)
    } finally { store.close() }
  })
  it('deduplicates visit events without treating refreshes as repeated observations', () => {
    const store = new ChatStore(':memory:')
    try {
      const sample = snapshot([message('u1', 'input')], { visitId: 'load-1' })
      const { conversationId: id } = store.assets.observe(source, sample)
      store.assets.observe(source, sample)
      store.assets.observe(source, { ...sample, visitId: 'load-2' })
      store.assets.graph.viewEvent(id, 'local:1'); store.assets.graph.viewEvent(id, 'local:1'); store.assets.graph.viewEvent(id, 'local:2')
      expect(store.assets.graph.summaries()).toEqual([{ conversationId: id, views: 4 }])
    } finally { store.close() }
  })
  it('exports deletion exclusions only for the matching account session', () => {
    const store = new ChatStore(':memory:')
    try {
      const observation = snapshot([message('u1', 'same input')])
      const first = store.assets.observe(source, observation)
      const second = store.assets.observe({ ...source, id: 'account-b' }, observation)
      store.deleteMessage(graph(store, second.conversationId).nodes[0].id)
      expect(JSON.parse(store.exportConversation(first.conversationId, 'json')).graph.exclusions).toEqual([])
    } finally { store.close() }
  })
  it('round trips branch state, local revisions and counters and rejects graph cycles atomically', () => {
    const store = new ChatStore(':memory:')
    try {
      const { conversationId: id } = store.assets.observe(source, snapshot([message('u1', 'first', '1'), message('a1', 'one', '1')], { visitId: '1' }))
      store.assets.observe(source, snapshot([message('u1', 'second', '2'), message('a1', 'two', '2')], { visitId: '1' }))
      const initial = graph(store, id); const first = initial.nodes.find(node => node.content === 'first')!
      store.assets.graph.select(id, first.id); store.updateMessage(first.id, { content: 'local first' })
      const exported = store.exportConversation(id, 'json')
      const imported = store.importConversation('json', exported, 'imported')
      const restored = graph(store, imported.id)
      expect(restored.nodes).toHaveLength(4)
      expect(restored.path.map(key => restored.nodes.find(node => node.id === key)!.content)).toEqual(['local first', 'one'])
      expect(store.assets.usage(undefined, imported.id).totalCharacters).toBe(store.assets.usage(undefined, id).totalCharacters)
      expect(store.assets.graph.summaries().find(row => row.conversationId === imported.id)?.views).toBe(1)
      const md = store.exportConversation(id, 'md'); expect(md).toContain('local first'); expect(md).not.toContain('\nsecond\n'); expect(md).not.toContain('\ntwo\n')
      const corrupt = JSON.parse(exported); corrupt.graph.nodes[0].parentId = corrupt.graph.nodes[1].id
      const count = store.listConversations().length
      expect(() => store.importConversation('json', JSON.stringify(corrupt), 'bad')).toThrow()
      expect(store.listConversations()).toHaveLength(count)
    } finally { store.close() }
  })
  it('deletes verified legacy menu fragments but keeps login discussion and interrupted inputs', () => {
    const store = new ChatStore(':memory:')
    try {
      const conversation = store.createConversation(source.id, 'webview', 'Mixed')
      const save = (content: string) => store.saveMessage({ conversationId: conversation.id, role: 'user', content, autoGrabbed: true })
      save('智谱十三刻 积分 519.76'); save('升级会员 我的订单 下载应用 更多设置 退出登录 积分519.76')
      save('如何实现用户登录和积分系统？')
      const input = store.createConversation(source.id, 'webview', 'Interrupted'); store.saveMessage({ conversationId: input.id, role: 'user', content: 'Only input', autoGrabbed: true })
      expect(store.cleanupInvalidConversations()).toMatchObject({ deletedCount: 0, messages: 2 })
      expect(store.listMessages(conversation.id).map(message => message.content)).toEqual(['如何实现用户登录和积分系统？'])
      expect(store.listMessages(input.id)).toHaveLength(1)
      expect(store.assets.cleanupRecords()).toHaveLength(2)
    } finally { store.close() }
  })
})
