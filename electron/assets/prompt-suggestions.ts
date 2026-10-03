import type { AssetPromptSuggestion } from '../shared/ai-assets.types.js'
import { promptWeight } from './text-usage.js'

export interface PromptSample { id: string; conversationId: string; content: string; before: string; after: string }
function edges(text: string): string {
  const chars = Array.from(text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim())
  const length = Math.ceil(chars.length * 0.1)
  return chars.length <= 20 ? chars.join('') : chars.slice(0, length).join('') + '\n' + chars.slice(-length).join('')
}
function grams(text: string): Set<string> {
  const chars = Array.from(text)
  return new Set(chars.length < 2 ? chars : chars.slice(1).map((char, index) => chars[index] + char))
}
function comparison(samples: PromptSample[], field: 'content' | 'before' | 'after') {
  const count = samples.length
  const common = new Uint32Array(count * count)
  const sizes = new Uint32Array(count)
  const index = new Map<string, number[]>()
  samples.forEach((sample, right) => {
    const tokens = grams(edges(sample[field]))
    sizes[right] = tokens.size
    for (const token of tokens) {
      const previous = index.get(token)
      if (!previous) { index.set(token, [right]); continue }
      for (const left of previous) common[left * count + right]++
      previous.push(right)
    }
  })
  return (left: number, right: number) => {
    if (left === right) return true
    const total = sizes[left] + sizes[right]
    return total === 0 || 2 * common[Math.min(left, right) * count + Math.max(left, right)] / total >= 0.8
  }
}
export function repeatedPromptSuggestions(samples: PromptSample[]): AssetPromptSuggestion[] {
  samples = samples.filter(sample => sample.content.trim())
  if (new Set(samples.map(sample => sample.conversationId)).size < 3) return []
  const inputMatches = comparison(samples, 'content')
  let beforeMatches: ReturnType<typeof comparison> | undefined
  let afterMatches: ReturnType<typeof comparison> | undefined
  const consumed = new Set<string>()
  const result: AssetPromptSuggestion[] = []
  for (const [candidateIndex, candidate] of samples.entries()) {
    if (consumed.has(candidate.id)) continue
    const matches = samples.filter((other, otherIndex) => {
      if (consumed.has(other.id) || !inputMatches(candidateIndex, otherIndex)) return false
      if (candidateIndex === otherIndex) return true
      beforeMatches ??= comparison(samples, 'before')
      if (!beforeMatches(candidateIndex, otherIndex)) return false
      afterMatches ??= comparison(samples, 'after')
      return afterMatches(candidateIndex, otherIndex)
    })
    const uses = new Set(matches.map(other => other.conversationId)).size
    if (uses < 3) continue
    const { content, conversationId, id } = candidate
    result.push({ content, conversationId, messageId: id, uses, weight: promptWeight(content, uses),
      title: Array.from(content.trim().split('\n')[0]).slice(0, 48).join('') })
    matches.forEach(other => consumed.add(other.id))
  }
  return result.sort((a, b) => b.weight - a.weight).slice(0, 100)
}
