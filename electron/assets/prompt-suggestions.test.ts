import { describe, expect, it } from 'vitest'
import { repeatedPromptSuggestions, type PromptSample } from './prompt-suggestions'

const sample = (id: string, changes: Partial<PromptSample> = {}): PromptSample => ({
  id, conversationId: id, content: 'Please summarize the topic and explain the result.', before: 'The previous response provides enough background.', after: 'The following response gives the requested summary.', ...changes,
})

describe('repeated prompt candidates', () => {
  it('requires three conversations and preserves the newest representative identity', () => {
    expect(repeatedPromptSuggestions([sample('a'), sample('b')])).toEqual([])
    const rows = [sample('newest'), sample('b'), sample('c'), sample('duplicate', { conversationId: 'b' })]
    expect(repeatedPromptSuggestions(rows)).toMatchObject([{ messageId: 'newest', conversationId: 'newest', uses: 3 }])
  })
  it('accepts similar inputs and context edges while ignoring variable middle content', () => {
    const content = 'Please summarize: ' + 'variable'.repeat(30) + ' Return the explanation.'
    const rows = ['a', 'b', 'c'].map((id, index) => sample(id, { content: content.replace('variable'.repeat(20), String(index).repeat(160)) }))
    expect(repeatedPromptSuggestions(rows)).toHaveLength(1)
  })
  it('rejects dissimilar or absent adjacent context', () => {
    expect(repeatedPromptSuggestions([sample('a'), sample('b'), sample('c', { before: 'Unrelated', after: 'Other' })])).toEqual([])
    expect(repeatedPromptSuggestions([sample('a'), sample('b'), sample('c', { before: '', after: '' })])).toEqual([])
    expect(repeatedPromptSuggestions(['a', 'b', 'c'].map(id => sample(id, { before: '', after: '' })))).toHaveLength(1)
  })
  it('keeps a low-similarity candidate out of an otherwise matching group', () => {
    const rows = ['a', 'b', 'c'].map(id => sample(id))
    rows.unshift(sample('other', { content: 'Generate a drawing of the landscape in blue.' }))
    expect(repeatedPromptSuggestions(rows)).toMatchObject([{ messageId: 'a', uses: 3 }])
  })
  it('includes the eighty-percent boundary and rejects a lower similarity', () => {
    const rows = [sample('a', { content: 'abcdef' }), sample('b', { content: 'abcdeg' }), sample('c', { content: 'abcdeg' })]
    expect(repeatedPromptSuggestions(rows)).toMatchObject([{ uses: 3 }])
    rows[0].content = 'abcdxy'
    expect(repeatedPromptSuggestions(rows)).toEqual([])
  })
})
