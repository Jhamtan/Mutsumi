/**
 * Shared data models and constants for itinerary planning.
 *
 * These types cross the renderer/preload/main process boundary, so they must be
 * plain JSON-serializable data: dates are always ISO strings, and time fields
 * may be null (a start point has no arrival time, an end point has no departure
 * time).
 */

/** A place's role in the itinerary: start / intermediate / end. */
export type TransportRole = 'start' | 'middle' | 'end'

/** Supported transport modes. */
export const TRANSPORT_MODES = [
  { value: 'car', label: '驾车', en: 'Driving' },
  { value: 'taxi', label: '打车', en: 'Taxi' },
  { value: 'subway', label: '地铁', en: 'Metro' },
  { value: 'bus', label: '公交车', en: 'Bus' },
  { value: 'bike', label: '骑行', en: 'Cycling' },
  { value: 'walk', label: '步行', en: 'Walking' },
  { value: 'train', label: '火车', en: 'Train' },
  { value: 'plane', label: '飞机', en: 'Flight' }
] as const

/** Transport mode code. */
export type TransportMode = (typeof TRANSPORT_MODES)[number]['value']

/** Transport mode code list (used for zod enum validation). */
export const TRANSPORT_MODE_VALUES = TRANSPORT_MODES.map((mode) => mode.value) as [
  TransportMode,
  ...TransportMode[]
]

/** Look up a transport mode label by code. */
export function transportModeLabel(value: TransportMode, locale: 'zh' | 'en' = 'zh'): string {
  const found = TRANSPORT_MODES.find((mode) => mode.value === value)
  if (!found) return value
  return locale === 'en' ? found.en : found.label
}

// ---- Limit constants ----
/** Maximum itinerary name length. */
export const ITINERARY_NAME_MAX_LENGTH = 120
/** Minimum number of places (start + end). */
export const ITINERARY_MIN_PLACES = 2
/** Maximum number of places. */
export const ITINERARY_MAX_PLACES = 50
/** Maximum duration of a single leg (minutes, 7 days). */
export const ITINERARY_MAX_DURATION_MINUTES = 7 * 24 * 60
/** Maximum stay at a single place (minutes, 7 days). */
export const ITINERARY_MAX_STAY_MINUTES = 7 * 24 * 60

// ---- Input DTOs ----
/** Input place: its role is derived from its array index (first = start, last = end, others = intermediate). */
export interface ItineraryPlaceInputDTO {
  name: string
  /** Stay time in minutes; meaningful only for intermediate places, defaults to 0. */
  stayMinutes?: number
}

/** Input leg: connects two adjacent places. */
export interface ItineraryLegInputDTO {
  mode: TransportMode
  /** Estimated travel time in minutes; must be greater than 0. */
  durationMinutes: number
}

/** Create-itinerary input. */
export interface CreateItineraryDTO {
  name: string
  /** Start departure time (ISO date-time); the anchor for computing the whole timeline. */
  startTime: string
  /** Ordered places, length >= 2: [start, ...intermediate, end]. */
  places: ItineraryPlaceInputDTO[]
  /** Ordered legs, length = places.length - 1. */
  legs: ItineraryLegInputDTO[]
}

/** Update-itinerary input. */
export interface UpdateItineraryDTO {
  itineraryId: number
  name: string
  startTime: string
  places: ItineraryPlaceInputDTO[]
  legs: ItineraryLegInputDTO[]
}

// ---- Output DTOs ----
/** A place in an itinerary; times are ISO strings or null. */
export interface ItineraryPlaceDTO {
  id: number
  name: string
  role: TransportRole
  sortOrder: number
  /** Arrival time; null for the start point. */
  arrivalTime: string | null
  /** Departure time; null for the end point. */
  departureTime: string | null
  /** Stay time in minutes; only intermediate places may be greater than 0. */
  stayMinutes: number
}

/** A leg of travel between two adjacent places. */
export interface ItineraryLegDTO {
  id: number
  fromPlaceId: number
  toPlaceId: number
  mode: TransportMode
  durationMinutes: number
  sortOrder: number
}

/** Full itinerary info. */
export interface ItineraryDTO {
  id: number
  uuid: string
  name: string
  places: ItineraryPlaceDTO[]
  legs: ItineraryLegDTO[]
  /** Start departure time (ISO). */
  startTime: string | null
  /** End arrival time (ISO). */
  endTime: string | null
  createdAt: string
  updatedAt: string
}

/** Itinerary list item. */
export interface ItinerarySummaryDTO {
  id: number
  uuid: string
  name: string
  startTime: string | null
  endTime: string | null
  startPlaceName: string | null
  endPlaceName: string | null
  placeCount: number
  createdAt: string
  updatedAt: string
  /** Present only in the abandoned-itinerary list; the soft-delete time. */
  deletedAt?: string | null
}
