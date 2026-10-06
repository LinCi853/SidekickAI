import { describe, expect, it } from 'vitest'
import { buildBlockerScript, matchDomain } from './webview-blocker.js'
import type { BlockRule } from '../../electron/shared/types'
import { createContext, runInContext } from 'node:vm'
import { buildBlockerCleanupScript } from './webview-blocker.js'

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

function fixture() {
  const styles: Array<{ id?: string; textContent?: string; remove: () => void }> = []
  const listeners = new Map<string, () => void>()
  const observers: Array<{ disconnected: boolean; callback: (changes: Array<{ addedNodes: number[] }>) => void }> = []
  const context = createContext({
    window: {}, console: { warn: () => {} },
    document: {
      head: { appendChild: (style: typeof styles[number]) => styles.push(style) }, body: {},
      createElement: () => { const style = { remove: () => { styles.splice(styles.indexOf(style), 1) } }; return style },
      querySelector: (selector: string) => { if (selector === '[') throw new Error('Invalid selector'); return null },
    },
    MutationObserver: class {
      disconnected = false
      constructor(readonly callback: typeof observers[number]['callback']) { observers.push(this) }
      observe() {}
      disconnect() { this.disconnected = true }
    },
  })
  runInContext('window = globalThis', context)
  context.addEventListener = (name: string, listener: () => void) => listeners.set(name, listener)
  context.removeEventListener = (name: string) => listeners.delete(name)
  return { context, styles, listeners, observers }
}

const cssRule = (selector: string): BlockRule => ({ id: 'css', label: 'CSS', type: 'css', selector,
  domainPattern: '*', enabled: true, builtin: false })

describe('blocker resource ownership', () => {
  it('updates its own style and releases it without a CSS observer', () => {
    const f = fixture()
    runInContext(buildBlockerScript([cssRule('.original')]), f.context)
    runInContext(buildBlockerScript([cssRule('.changed')]), f.context)
    expect(f.styles).toHaveLength(1)
    expect(f.styles[0].textContent).toContain('.changed')
    expect(f.styles[0].textContent).not.toContain('.original')
    expect(f.observers).toHaveLength(0)
    runInContext(buildBlockerCleanupScript(), f.context)
    expect(f.styles).toHaveLength(0)
    expect(f.listeners.size).toBe(0)
  })

  it('disconnects its dynamic observer and reports custom script reload requirements', () => {
    const f = fixture()
    const rule: BlockRule = { ...cssRule(''), id: 'js', type: 'js', jsCode: 'window.customCount = (window.customCount || 0) + 1' }
    runInContext(buildBlockerScript([rule]), f.context)
    f.observers[0].callback([{ addedNodes: [1] }])
    expect(f.context.customCount).toBe(2)
    const result = runInContext(buildBlockerCleanupScript(), f.context)
    expect(f.observers[0].disconnected).toBe(true)
    expect(result.requiresReload).toBe(true)
    expect(f.context.customCount).toBe(2)
  })

  it('isolates invalid selectors and bounds repeated script errors by rule', () => {
    const f = fixture()
    const rule: BlockRule = { ...cssRule(''), id: 'js', type: 'js', jsCode: 'throw new Error("Fixture script failure")' }
    runInContext(buildBlockerScript([cssRule('['), { ...cssRule('.valid'), id: 'valid' }, rule]), f.context)
    for (let index = 0; index < 10; index += 1) f.observers[0].callback([{ addedNodes: [1] }])
    expect(f.styles[0].textContent).toContain('.valid')
    expect(f.context.__ai_blocker_state__.errors).toHaveLength(2)
    expect(f.context.__ai_blocker_state__.errors.map((error: { id: string }) => error.id)).toEqual(['css', 'js'])
  })
})
