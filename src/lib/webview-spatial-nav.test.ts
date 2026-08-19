import { describe, expect, it } from 'vitest'
import { buildSpatialNavScript } from './webview-spatial-nav.js'

describe('buildSpatialNavScript', () => {
  it('should return a valid JavaScript string', () => {
    const script = buildSpatialNavScript()
    expect(typeof script).toBe('string')
    expect(script.length).toBeGreaterThan(0)
  })

  it('should be parseable JavaScript', () => {
    const script = buildSpatialNavScript()
    expect(() => new Function(script)).not.toThrow()
  })

  it('should include idempotency check', () => {
    const script = buildSpatialNavScript()
    expect(script).toContain('__ai_spatial_nav__')
  })

  it('should include keyboard event handling', () => {
    const script = buildSpatialNavScript()
    expect(script).toContain('keydown')
    expect(script).toContain('ArrowUp')
    expect(script).toContain('ArrowDown')
    expect(script).toContain('ArrowLeft')
    expect(script).toContain('ArrowRight')
  })

  it('should include gamepad support', () => {
    const script = buildSpatialNavScript()
    expect(script).toContain('getGamepads')
  })

  it('should include toggle mechanism', () => {
    const script = buildSpatialNavScript()
    expect(script).toContain('toggle')
  })

  it('should include virtual cursor', () => {
    const script = buildSpatialNavScript()
    expect(script).toContain('cursor')
  })
})
