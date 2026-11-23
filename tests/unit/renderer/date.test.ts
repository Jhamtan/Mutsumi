import { describe, expect, it } from 'vitest'
import { formatDate, formatDateTime } from '../../../src/renderer/src/utils/date'

/**
 * Tests the locale-aware date formatting helpers: valid timestamps render a
 * non-empty localized string, invalid ones fall back to an empty string.
 */
describe('date formatting', () => {
  const iso = '2026-11-07T09:30:00.000Z'

  it('formats a date-time string in both locales', () => {
    expect(formatDateTime(iso, 'zh')).toContain('2026')
    expect(formatDateTime(iso, 'en')).toContain('2026')
  })

  it('formats a date-only string in both locales', () => {
    expect(formatDate(iso, 'zh')).toContain('2026')
    expect(formatDate(iso, 'en')).toContain('2026')
  })

  it('returns an empty string for invalid dates', () => {
    expect(formatDateTime('not-a-date', 'zh')).toBe('')
    expect(formatDate('', 'en')).toBe('')
  })
})
