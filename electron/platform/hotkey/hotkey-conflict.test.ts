import { describe, expect, it } from 'vitest'
import {
  KNOWN_HOTKEY_GRABBERS,
  rankConflictCandidates,
  type ProcessInfo,
} from './hotkey-conflict.js'

const proc = (pid: number, name: string, commandLine = ''): ProcessInfo => ({
  pid,
  name,
  commandLine,
})

describe('hotkey conflict candidate ranking', () => {
  it('ranks confirmed grabbers before possible ones, with hints', () => {
    const ranked = rankConflictCandidates([
      proc(100, 'chrome.exe'),
      proc(200, 'Trae CN.exe'),
      proc(300, 'QQ.exe'),
    ])
    expect(ranked.map((c) => `${c.name}:${c.confidence}`)).toEqual([
      'Trae CN.exe:high',
      'QQ.exe:medium',
      'chrome.exe:medium',
    ])
    expect(ranked[0].hint).toContain('trae.floatingChat.shortcut')
    expect(ranked[1].hint).toContain('QQ 设置')
    expect(ranked[2].hint).toBeTruthy()
  })

  it('covers doubao IME, zhipu, 360 and browser-family grabbers', () => {
    const ranked = rankConflictCandidates([
      proc(1, 'ImeService.exe'),
      proc(2, '智谱清言.exe'),
      proc(3, '360Tray.exe'),
      proc(4, 'msedge.exe'),
      proc(5, 'qqbrowser.exe'),
    ])
    const byName = Object.fromEntries(ranked.map((c) => [c.name, c]))
    expect(byName['ImeService.exe'].confidence).toBe('high')
    expect(byName['ImeService.exe'].hint).toContain('豆包')
    expect(byName['智谱清言.exe'].confidence).toBe('medium')
    expect(byName['360Tray.exe'].hint).toContain('360')
    expect(byName['msedge.exe'].hint).toBeTruthy()
    expect(byName['qqbrowser.exe'].hint).toBeTruthy()
  })

  it('excludes system and host processes', () => {
    const ranked = rankConflictCandidates([
      proc(1, 'svchost.exe'),
      proc(2, 'conhost.exe'),
      proc(3, 'dwm.exe'),
      proc(4, 'msedgewebview2.exe'),
      proc(5, 'powershell.exe'),
      proc(6, 'Trae CN.exe'),
    ])
    expect(ranked.map((c) => c.name)).toEqual(['Trae CN.exe'])
  })

  it('dedupes same-name processes into one candidate with instance count', () => {
    const ranked = rankConflictCandidates([
      proc(11, 'chrome.exe'),
      proc(12, 'chrome.exe'),
      proc(13, 'chrome.exe'),
      proc(14, 'Trae CN.exe'),
    ])
    expect(ranked).toHaveLength(2)
    expect(ranked[0].name).toBe('Trae CN.exe')
    expect(ranked[1]).toMatchObject({ name: 'chrome.exe', instances: 3 })
  })

  it('keeps every known grabber mapped to confidence and concrete hint', () => {
    for (const entry of KNOWN_HOTKEY_GRABBERS) {
      expect(['high', 'medium']).toContain(entry.confidence)
      expect(entry.hint.length).toBeGreaterThan(0)
      expect(entry.reason.length).toBeGreaterThan(0)
    }
  })

  it('sorts unknown user apps deterministically by name at the end', () => {
    const ranked = rankConflictCandidates([
      proc(11, 'Zeta.exe'),
      proc(12, 'Alpha.exe'),
      proc(13, 'MiMoHelper.exe'),
      proc(14, 'Trae CN.exe'),
    ])
    expect(ranked.map((c) => c.name)).toEqual([
      'Trae CN.exe',
      'Alpha.exe',
      'MiMoHelper.exe',
      'Zeta.exe',
    ])
    expect(ranked[3].confidence).toBe('low')
    expect(ranked[3].hint).toBeNull()
  })
})
