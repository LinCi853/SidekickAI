import { describe, expect, it } from 'vitest'
import { SCRAPE_CHAT_SCRIPT, DETECT_LOGIN_SCRIPT } from './scripts.js'

describe('SCRAPE_CHAT_SCRIPT', () => {
  it('should be a valid JavaScript string', () => {
    expect(typeof SCRAPE_CHAT_SCRIPT).toBe('string')
    expect(SCRAPE_CHAT_SCRIPT.length).toBeGreaterThan(0)
  })

  it('should be parseable JavaScript', () => {
    expect(() => new Function(SCRAPE_CHAT_SCRIPT)).not.toThrow()
  })

  it('should include platform selectors', () => {
    expect(SCRAPE_CHAT_SCRIPT).toContain('chatgpt.com')
    expect(SCRAPE_CHAT_SCRIPT).toContain('claude.ai')
    expect(SCRAPE_CHAT_SCRIPT).toContain('deepseek.com')
    expect(SCRAPE_CHAT_SCRIPT).toContain('kimi.moonshot.cn')
  })

  it('should include fallback selectors', () => {
    expect(SCRAPE_CHAT_SCRIPT).toContain('FALLBACK_SELECTORS')
  })

  it('should return pairs, title, url', () => {
    expect(SCRAPE_CHAT_SCRIPT).toContain('pairs')
    expect(SCRAPE_CHAT_SCRIPT).toContain('title')
    expect(SCRAPE_CHAT_SCRIPT).toContain('url')
  })
})

describe('DETECT_LOGIN_SCRIPT', () => {
  it('should be a valid JavaScript string', () => {
    expect(typeof DETECT_LOGIN_SCRIPT).toBe('string')
    expect(DETECT_LOGIN_SCRIPT.length).toBeGreaterThan(0)
  })

  it('should be parseable JavaScript', () => {
    expect(() => new Function(DETECT_LOGIN_SCRIPT)).not.toThrow()
  })

  it('should return login status', () => {
    expect(DETECT_LOGIN_SCRIPT).toContain('isLoggedIn')
  })

  it('should return url and cookie', () => {
    expect(DETECT_LOGIN_SCRIPT).toContain('url')
    expect(DETECT_LOGIN_SCRIPT).toContain('cookie')
  })
})
