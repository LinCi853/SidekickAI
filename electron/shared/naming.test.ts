import { describe, expect, it } from 'vitest'
import { generateUniqueName } from './naming.js'

describe('generateUniqueName', () => {
  it('should return base name when no conflict', () => {
    expect(generateUniqueName('Test', [])).toBe('Test')
    expect(generateUniqueName('Test', ['Other'])).toBe('Test')
  })

  it('should append -2 when base name exists', () => {
    expect(generateUniqueName('Test', ['Test'])).toBe('Test-2')
  })

  it('should append incrementing suffix until unique', () => {
    expect(generateUniqueName('Test', ['Test', 'Test-2', 'Test-3'])).toBe('Test-4')
  })

  it('should handle empty base name', () => {
    expect(generateUniqueName('', [])).toBe('')
    expect(generateUniqueName('', [''])).toBe('-2')
  })

  it('should handle names with existing suffix', () => {
    expect(generateUniqueName('Test-2', ['Test-2'])).toBe('Test-2-2')
  })

  it('should not modify non-conflicting names with numbers', () => {
    expect(generateUniqueName('Test-5', ['Test', 'Test-2'])).toBe('Test-5')
  })
})
