import { describe, expect, it } from 'vitest'
import {
  computeTimes,
  formatClock,
  formatDuration,
  formatTripDate,
  formatDiagramClock,
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

  it('matches the Chengdu to Chongqing to Beijing reference timeline', () => {
    const departure = new Date(2026, 10, 25, 12, 0)
    const times = computeTimes(departure, [0, 40, 0], [50, 120])
    expect(formatDiagramClock(times[0].departureTime, departure)).toBe('12:00')
    expect(formatDiagramClock(times[1].arrivalTime, departure)).toBe('12:50')
    expect(formatDiagramClock(times[1].departureTime, departure)).toBe('13:30')
    expect(formatDiagramClock(times[2].arrivalTime, departure)).toBe('15:30')
  })
})

describe('trip diagram formatting', () => {
  it('uses the local departure date for a Date and ISO string', () => {
    const date = new Date(2026, 10, 25, 0, 30)
    expect(formatTripDate(date)).toBe('11月25日')
    expect(formatTripDate(date.toISOString())).toBe('11月25日')
    expect(formatTripDate(date, 'en')).toBe('Nov 25')
  })

  it.each([null, undefined, 'not-a-date'])('does not fabricate missing dates: %s', (value) => {
    expect(formatTripDate(value)).toBe('')
    expect(formatDiagramClock(value, null)).toBe('—')
  })

  it('includes next-day and next-year dates instead of ambiguous clocks', () => {
    const departure = new Date(2026, 11, 31, 23, 50)
    const arrival = new Date(2027, 0, 1, 0, 10)
    expect(formatDiagramClock(arrival, departure)).toBe('2027年1月1日 00:10')
    expect(formatDiagramClock(arrival, departure, 'en')).toBe('Jan 1, 2027 00:10')
    const sameYearDeparture = new Date(2026, 10, 25, 23, 50)
    const nextDay = new Date(2026, 10, 26, 0, 10)
    expect(formatDiagramClock(nextDay, sameYearDeparture)).toBe('11月26日 00:10')
  })

  it('localizes duration labels without changing the Chinese default', () => {
    expect(formatDuration(50, 'en')).toBe('50 min')
    expect(formatDuration(120, 'en')).toBe('2 hr')
    expect(formatDuration(125, 'en')).toBe('2 hr 5 min')
    expect(formatDuration(50)).toBe('50分钟')
  })
})
