/**
 * Itinerary renderer helpers: duration/time formatting and time computation
 * (kept consistent with the backend, used for live preview while editing).
 */
import type { TransportMode } from '@common/types'
import { transportModeLabel } from '@common/types'

/** Formats a duration in minutes as "Xh Ym". */
export function formatDuration(minutes: number, locale: 'zh' | 'en' = 'zh'): string {
  if (!Number.isFinite(minutes) || minutes < 0) return ''
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (locale === 'en') {
    if (h === 0) return `${m} min`
    if (m === 0) return `${h} hr`
    return `${h} hr ${m} min`
  }
  if (h === 0) return `${m}分钟`
  if (m === 0) return `${h}小时`
  return `${h}小时${m}分钟`
}

/** Formats a time as "MM/DD HH:mm"; empty values show a placeholder. */
export function formatClock(value: Date | string | null | undefined): string {
  if (!value) return '—'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function tripDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

/** Use the departure's local calendar date, never the UTC ISO date substring. */
export function formatTripDate(
  value: Date | string | null | undefined,
  locale: 'zh' | 'en' = 'zh'
): string {
  const date = tripDate(value)
  if (!date) return ''
  if (locale === 'en')
    return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(date)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

/** Same-day clocks stay compact; crossing midnight/year makes the date explicit. */
export function formatDiagramClock(
  value: Date | string | null | undefined,
  departure: Date | string | null | undefined,
  locale: 'zh' | 'en' = 'zh'
): string {
  const date = tripDate(value)
  if (!date) return '—'
  const anchor = tripDate(departure)
  const pad = (part: number): string => String(part).padStart(2, '0')
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (
    anchor &&
    date.getFullYear() === anchor.getFullYear() &&
    date.getMonth() === anchor.getMonth() &&
    date.getDate() === anchor.getDate()
  )
    return clock
  let day = formatTripDate(date, locale)
  if (!anchor || date.getFullYear() !== anchor.getFullYear()) {
    day = locale === 'zh' ? `${date.getFullYear()}年${day}` : `${day}, ${date.getFullYear()}`
  }
  return `${day} ${clock}`
}

/** Chinese/English label for a transport mode. */
export function modeLabel(mode: TransportMode, locale: 'zh' | 'en' = 'zh'): string {
  return transportModeLabel(mode, locale)
}

/** Times computed for a single place. */
export interface TimedPlace {
  arrivalTime: Date | null
  departureTime: Date | null
}

/**
 * Computes each place's times: the start point has only a departure time; an
 * intermediate place's arrival = previous departure + travel duration, and its
 * departure = arrival + stay; the end point has only an arrival time.
 *
 * @param startTime the start point's departure time (Date)
 * @param stays stay minutes for each place (one-to-one with places; start/end should be 0)
 * @param durations travel minutes per leg (length = place count - 1)
 */
export function computeTimes(startTime: Date, stays: number[], durations: number[]): TimedPlace[] {
  const times: TimedPlace[] = [{ arrivalTime: null, departureTime: startTime }]
  let departure = startTime
  for (let i = 0; i < durations.length; i++) {
    const arrival = new Date(departure.getTime() + durations[i] * 60_000)
    const isEnd = i === durations.length - 1
    const nextDeparture = isEnd ? null : new Date(arrival.getTime() + (stays[i + 1] ?? 0) * 60_000)
    times.push({ arrivalTime: arrival, departureTime: nextDeparture })
    departure = nextDeparture ?? arrival
  }
  return times
}
