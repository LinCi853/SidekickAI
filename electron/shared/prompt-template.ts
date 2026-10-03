import type { PromptTemplate } from './chat.types.js'

export function validatePromptTemplate(value: unknown, allowLegacyBlank = false): asserts value is PromptTemplate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid prompt template')
  const template = value as Record<string, unknown>
  if (typeof template.title !== 'string' || !template.title.trim()) throw new Error('Prompt title is required')
  if (typeof template.content !== 'string') throw new Error('Invalid prompt content')
  for (const field of ['id', 'category', 'hotkey']) {
    if (template[field] !== undefined && typeof template[field] !== 'string') throw new Error(`Invalid prompt ${field}`)
  }
  for (const field of ['createdAt', 'updatedAt']) {
    if (template[field] !== undefined && (typeof template[field] !== 'number' || !Number.isFinite(template[field]))) {
      throw new Error(`Invalid prompt ${field}`)
    }
  }
  let exampleContent = ''
  if (template.example !== undefined) {
    if (!template.example || typeof template.example !== 'object' || Array.isArray(template.example)) throw new Error('Invalid prompt example')
    const example = template.example as Record<string, unknown>
    if (typeof example.content !== 'string') throw new Error('Invalid prompt example content')
    for (const field of ['conversationId', 'messageId']) {
      if (example[field] !== undefined && (typeof example[field] !== 'string' || !example[field].trim())) throw new Error(`Invalid prompt example ${field}`)
    }
    if (example.messageId && !example.conversationId) throw new Error('Prompt example message requires a conversation')
    exampleContent = example.content
  }
  if (!template.content.trim() && !exampleContent.trim() && !(allowLegacyBlank && template.example === undefined)) {
    throw new Error('Prompt content or example is required')
  }
}

export function hasUsablePromptContent(template: Pick<PromptTemplate, 'content'>): boolean {
  return typeof template?.content === 'string' && template.content.trim().length > 0
}
