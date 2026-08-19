import { describe, expect, it } from 'vitest'
import { buildCookieHandlerScript, type CookieHandlerConfig } from './cookie-handler.js'

describe('buildCookieHandlerScript', () => {
  const defaultConfig: CookieHandlerConfig = {
    whitelist: [],
    blacklist: [],
    cooldownMs: 5000,
    enabled: true,
  }

  it('should return empty string when disabled', () => {
    const config = { ...defaultConfig, enabled: false }
    const script = buildCookieHandlerScript('example.com', config)
    expect(script).toBe('')
  })

  it('should return empty string when hostname not in whitelist or blacklist', () => {
    const config = { ...defaultConfig, whitelist: ['other.com'] }
    const script = buildCookieHandlerScript('example.com', config)
    expect(script).toBe('')
  })

  it('should generate blacklist script for blacklisted domain', () => {
    const config = { ...defaultConfig, blacklist: ['example.com'] }
    const script = buildCookieHandlerScript('example.com', config)

    expect(script).toContain('__ai_cookie_handler_injected__')
    expect(script).toContain('display: none')
    expect(script).toContain('黑名单域名')
  })

  it('should generate whitelist script for whitelisted domain', () => {
    const config = { ...defaultConfig, whitelist: ['example.com'] }
    const script = buildCookieHandlerScript('example.com', config)

    expect(script).toContain('__ai_cookie_handler_injected__')
    expect(script).toContain('findAcceptButton')
    expect(script).toContain('MutationObserver')
  })

  it('should include cooldown mechanism in whitelist script', () => {
    const config = { ...defaultConfig, whitelist: ['example.com'], cooldownMs: 10000 }
    const script = buildCookieHandlerScript('example.com', config)

    expect(script).toContain('COOLDOWN_MS')
    expect(script).toContain('10000')
  })

  it('should include common accept button selectors', () => {
    const config = { ...defaultConfig, whitelist: ['example.com'] }
    const script = buildCookieHandlerScript('example.com', config)

    expect(script).toContain('onetrust-accept-btn-handler')
    expect(script).toContain('CybotCookiebotDialogBodyButtonAccept')
  })

  it('should match subdomains in whitelist', () => {
    const config = { ...defaultConfig, whitelist: ['example.com'] }
    const script = buildCookieHandlerScript('sub.example.com', config)

    expect(script).not.toBe('')
  })

  it('should match wildcard patterns', () => {
    const config = { ...defaultConfig, whitelist: ['*.example.com'] }
    const script = buildCookieHandlerScript('sub.example.com', config)

    expect(script).not.toBe('')
  })

  it('should prioritize blacklist over whitelist', () => {
    const config = {
      ...defaultConfig,
      whitelist: ['example.com'],
      blacklist: ['example.com'],
    }
    const script = buildCookieHandlerScript('example.com', config)

    // Blacklist should take precedence
    expect(script).toContain('黑名单域名')
  })

  it('should include timeout for observer disconnect', () => {
    const config = { ...defaultConfig, whitelist: ['example.com'] }
    const script = buildCookieHandlerScript('example.com', config)

    expect(script).toContain('setTimeout')
    expect(script).toContain('observer.disconnect()')
  })
})
