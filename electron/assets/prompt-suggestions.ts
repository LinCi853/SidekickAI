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
function similarity(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return left.size === right.size ? 1 : 0
  let common = 0
  for (const value of left) if (right.has(value)) common++
  return 2 * common / (left.size + right.size)
}
export function repeatedPromptSuggestions(samples: PromptSample[]): AssetPromptSuggestion[] {
  const prepared = samples.map(sample => ({ sample, parts: [sample.content, sample.before, sample.after].map(text => grams(edges(text))) }))
  const consumed = new Set<string>()
  const result: AssetPromptSuggestion[] = []
  for (const candidate of prepared) {
    if (consumed.has(candidate.sample.id)) continue
    const matches = prepared.filter(other => !consumed.has(other.sample.id)
      && candidate.parts.every((part, index) => similarity(part, other.parts[index]) >= 0.8))
    const uses = new Set(matches.map(other => other.sample.conversationId)).size
    if (uses < 3) continue
    const { content, conversationId, id } = candidate.sample
    result.push({ content, conversationId, messageId: id, uses, weight: promptWeight(content, uses),
      title: Array.from(content.trim().split('\n')[0]).slice(0, 48).join('') })
    matches.forEach(other => consumed.add(other.sample.id))
  }
  return result.sort((a, b) => b.weight - a.weight).slice(0, 100)
}
