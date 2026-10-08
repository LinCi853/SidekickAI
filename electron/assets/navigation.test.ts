import { describe, expect, it } from 'vitest'
import { getAssetNavigation, setAssetNavigation } from './navigation'

describe('asset navigation', () => {
  it('retains the latest request until a new renderer subscribes', () => {
    const prompts = setAssetNavigation({ category: 'prompts' })
    expect(getAssetNavigation()).toEqual(prompts)
    const search = setAssetNavigation({ focusSearch: true })
    expect(search.revision).toBeGreaterThan(prompts.revision)
    expect(search.category).toBeUndefined()
    expect(getAssetNavigation().focusSearch).toBe(true)
  })
  it('opens settings without changing the current category', () => {
    const page = setAssetNavigation({ openSettings: true })
    expect(page.openSettings).toBe(true)
    expect(page.category).toBeUndefined()
    expect(setAssetNavigation({ category: 'invalid' } as never).category).toBeUndefined()
  })
})
