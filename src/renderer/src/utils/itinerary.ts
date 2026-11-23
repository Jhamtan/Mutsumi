/**
 * Itinerary renderer helpers: duration/time formatting and time computation
 * (kept consistent with the backend, used for live preview while editing).
 */
import type { TransportMode } from '@common/types'
import { transportModeLabel } from '@common/types'

/** Formats a duration in minutes as "Xh Ym". */
export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return ''
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
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
