import { describe, expect, it } from 'vitest'
import { buildBlockerScript, matchDomain } from './webview-blocker.js'
import type { BlockRule } from '../../electron/shared/types'

describe('matchDomain', () => {
  it('should match wildcard pattern', () => {
    expect(matchDomain('*', 'anything.com')).toBe(true)
  })

  it('should match exact domain', () => {
    expect(matchDomain('chatgpt.com', 'chatgpt.com')).toBe(true)
  })

  it('should match subdomain with wildcard', () => {
    expect(matchDomain('*.chatgpt.com', 'chatgpt.com')).toBe(true)
    expect(matchDomain('*.chatgpt.com', 'sub.chatgpt.com')).toBe(true)
  })

  it('should not match different domain', () => {
    expect(matchDomain('chatgpt.com', 'google.com')).toBe(false)
  })

  it('should not match partial domain', () => {
    expect(matchDomain('chatgpt.com', 'xchatgpt.com')).toBe(false)
  })

  it('should match subdomain', () => {
    expect(matchDomain('chatgpt.com', 'sub.chatgpt.com')).toBe(true)
  })
})

describe('buildBlockerScript', () => {
  it('should build script for CSS rules', () => {
    const rules: BlockRule[] = [
      { id: '1', label: 'Test', type: 'css', selector: '.ad-banner', domainPattern: '*', enabled: true, builtin: false },
    ]

    const script = buildBlockerScript(rules)

    expect(script).toContain('__ai_blocker_injected__')
    expect(script).toContain('.ad-banner')
    expect(script).toContain('display: none')
  })

  it('should build script for JS rules', () => {
    const rules: BlockRule[] = [
      { id: '1', label: 'Test', type: 'js', selector: '', jsCode: 'console.log("blocked")', domainPattern: '*', enabled: true, builtin: false },
    ]

    const script = buildBlockerScript(rules)

    // The JS code is JSON.stringified in the script, so quotes are escaped
    expect(script).toContain('console.log')
    expect(script).toContain('blocked')
  })

  it('should build script for mixed rules', () => {
    const rules: BlockRule[] = [
      { id: '1', label: 'CSS Rule', type: 'css', selector: '.ad', domainPattern: '*', enabled: true, builtin: false },
      { id: '2', label: 'JS Rule', type: 'js', selector: '', jsCode: 'alert("test")', domainPattern: '*', enabled: true, builtin: false },
    ]

    const script = buildBlockerScript(rules)

    expect(script).toContain('.ad')
    expect(script).toContain('alert')
    expect(script).toContain('test')
  })

  it('should include MutationObserver for dynamic content', () => {
    const rules: BlockRule[] = []
    const script = buildBlockerScript(rules)

    expect(script).toContain('MutationObserver')
  })

  it('should include idempotency check', () => {
    const rules: BlockRule[] = []
    const script = buildBlockerScript(rules)

    expect(script).toContain('window.__ai_blocker_injected__')
  })
})
