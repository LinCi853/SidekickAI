import { describe, expect, it } from 'vitest'
import { formatTime } from './datetime.js'

describe('formatTime', () => {
  it('should format timestamp in datetime mode', () => {
    // 2024-01-15 14:30:00
    const ts = new Date(2024, 0, 15, 14, 30, 0).getTime()
    expect(formatTime(ts)).toBe('2024-01-15 14:30')
  })

  it('should format timestamp in time mode', () => {
    // 14:30:00
    const ts = new Date(2024, 0, 15, 14, 30, 0).getTime()
    expect(formatTime(ts, 'time')).toBe('14:30')
  })

  it('should pad single digit hours and minutes', () => {
    // 09:05:00
    const ts = new Date(2024, 0, 15, 9, 5, 0).getTime()
    expect(formatTime(ts, 'time')).toBe('09:05')
    expect(formatTime(ts)).toBe('2024-01-15 09:05')
  })

  it('should handle midnight', () => {
    const ts = new Date(2024, 0, 15, 0, 0, 0).getTime()
    expect(formatTime(ts, 'time')).toBe('00:00')
  })

  it('should handle end of day', () => {
    const ts = new Date(2024, 0, 15, 23, 59, 0).getTime()
    expect(formatTime(ts, 'time')).toBe('23:59')
  })

  it('should default to datetime mode', () => {
    const ts = new Date(2024, 0, 15, 14, 30, 0).getTime()
    expect(formatTime(ts)).toBe('2024-01-15 14:30')
  })
})
