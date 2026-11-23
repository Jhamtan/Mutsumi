import { describe, expect, it } from 'vitest'
import {
  computeTimes,
  formatClock,
  formatDuration,
  modeLabel
} from '../../../src/renderer/src/utils/itinerary'

/**
 * Tests the itinerary renderer helpers: duration/clock formatting and the
 * live time derivation used by the editor.
 */
describe('formatDuration', () => {
  it('formats minutes, hours, and mixed durations', () => {
    expect(formatDuration(0)).toBe('0分钟')
    expect(formatDuration(30)).toBe('30分钟')
    expect(formatDuration(60)).toBe('1小时')
    expect(formatDuration(90)).toBe('1小时30分钟')
    expect(formatDuration(125)).toBe('2小时5分钟')
  })

  it('returns an empty string for invalid input', () => {
    expect(formatDuration(-1)).toBe('')
    expect(formatDuration(Number.NaN)).toBe('')
  })
})

describe('formatClock', () => {
  it('formats a Date and an ISO string identically', () => {
    const date = new Date('2026-11-12T09:30:00.000Z')
    expect(formatClock(date)).toBe(formatClock('2026-11-12T09:30:00.000Z'))
    expect(formatClock(date)).toContain('11/12')
  })

  it('renders a placeholder for missing or invalid values', () => {
    expect(formatClock(null)).toBe('—')
    expect(formatClock(undefined)).toBe('—')
    expect(formatClock('not-a-date')).toBe('—')
  })
})

describe('modeLabel', () => {
  it('maps a mode code to its Chinese label by default', () => {
    expect(modeLabel('car')).toBe('驾车')
    expect(modeLabel('plane')).toBe('飞机')
  })

  it('maps to the English label when requested', () => {
    expect(modeLabel('car', 'en')).toBe('Driving')
    expect(modeLabel('plane', 'en')).toBe('Flight')
  })
})

describe('computeTimes', () => {
  const start = new Date('2026-11-12T09:00:00.000Z')

  it('derives start departure and end arrival for a two-place trip', () => {
    const times = computeTimes(start, [0, 0], [30])
    expect(times[0].arrivalTime).toBeNull()
    expect(times[0].departureTime!.toISOString()).toBe('2026-11-12T09:00:00.000Z')
    expect(times[1].departureTime).toBeNull()
    expect(times[1].arrivalTime!.toISOString()).toBe('2026-11-12T09:30:00.000Z')
  })

  it('applies stay time to a middle place departure', () => {
    const times = computeTimes(start, [0, 20, 0], [30, 15])
    expect(times[1].arrivalTime!.toISOString()).toBe('2026-11-12T09:30:00.000Z')
    expect(times[1].departureTime!.toISOString()).toBe('2026-11-12T09:50:00.000Z')
    expect(times[2].arrivalTime!.toISOString()).toBe('2026-11-12T10:05:00.000Z')
  })

  it('treats a zero stay as arrival equal to departure', () => {
    const times = computeTimes(start, [0, 0, 0], [20, 10])
    expect(times[1].arrivalTime!.getTime()).toBe(times[1].departureTime!.getTime())
  })
})
