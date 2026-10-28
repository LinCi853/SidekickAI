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
  it('ranks known grabbers first with resolution hints', () => {
    const ranked = rankConflictCandidates([
      proc(100, 'notepad++.exe'),
      proc(200, 'Trae CN.exe'),
      proc(300, 'ToDesk.exe'),
    ])
    expect(ranked[0].name).toBe('Trae CN.exe')
    expect(ranked[0].hint).toContain('trae.floatingChat.shortcut')
    expect(ranked[1].name).toBe('ToDesk.exe')
    expect(ranked[1].hint).toBeTruthy()
    expect(ranked[2].name).toBe('notepad++.exe')
    expect(ranked[2].hint).toBeNull()
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

  it('keeps every known grabber mapped to a concrete hint', () => {
    for (const entry of KNOWN_HOTKEY_GRABBERS) {
      expect(entry.hint.length).toBeGreaterThan(0)
      expect(entry.reason.length).toBeGreaterThan(0)
    }
  })

  it('sorts unknown user apps deterministically by name', () => {
    const ranked = rankConflictCandidates([
      proc(11, 'Zeta.exe'),
      proc(12, 'Alpha.exe'),
      proc(13, 'MiMoHelper.exe'),
    ])
    expect(ranked.map((c) => c.name)).toEqual(['Alpha.exe', 'MiMoHelper.exe', 'Zeta.exe'])
  })
})
