/**
 * Itinerary service: validates input, computes each place's arrival/departure
 * time from "departure time + travel duration + stay time", and handles CRUD,
 * soft delete (abandon), restore and permanent delete.
 */
import { randomUUID } from 'node:crypto'
import type { Transaction } from 'sequelize'
import type {
  CreateItineraryDTO,
  ItineraryDTO,
  ItineraryLegInputDTO,
  ItinerarySummaryDTO,
  TransportRole,
  UpdateItineraryDTO
} from '@common/itinerary'
import {
  ITINERARY_MAX_DURATION_MINUTES,
  ITINERARY_MAX_PLACES,
  ITINERARY_MAX_STAY_MINUTES,
  ITINERARY_MIN_PLACES
} from '@common/itinerary'
import { AppError } from '../errors'
import type { Itinerary } from '../database/models/itinerary.model'
import type { ItineraryPlace } from '../database/models/itinerary-place.model'
import type { ItineraryLeg } from '../database/models/itinerary-leg.model'
import ItineraryRepository from '../database/repositories/ItineraryRepository'
import ItineraryPlaceRepository from '../database/repositories/ItineraryPlaceRepository'
import ItineraryLegRepository from '../database/repositories/ItineraryLegRepository'
import { registerTransactionGuard } from '../database/transaction'

/** A normalized place (role already determined by order). */
interface NormalizedPlace {
  name: string
  role: TransportRole
  stayMinutes: number
}

/** A normalized leg. */
interface NormalizedLeg {
  mode: ItineraryLegInputDTO['mode']
  durationMinutes: number
}

/** Times computed for a single place. */
interface ComputedTimes {
  arrivalTime: Date | null
  departureTime: Date | null
}

const MINUTE_MS = 60_000

/** Itinerary planning business logic. */
export class ItineraryService {
  constructor(
    private readonly itineraries = new ItineraryRepository(),
    private readonly places = new ItineraryPlaceRepository(),
    private readonly legs = new ItineraryLegRepository()
  ) {}

  /** Lists all active itineraries for a user (with summary info). */
  async list(userId: number, guard?: () => void): Promise<ItinerarySummaryDTO[]> {
    guard?.()
    const result = await this.itineraries.readSnapshot(async (transaction) => {
      guard?.()
      const rows = await this.itineraries.findAllOwned(userId, { transaction })
      guard?.()
      const summaries = await this.toSummaries(rows, transaction, guard)
      guard?.()
      return summaries
    })
    guard?.()
    return result
  }

  /** Lists the user's abandoned (soft-deleted) itineraries. */
  async listAbandoned(userId: number, guard?: () => void): Promise<ItinerarySummaryDTO[]> {
    guard?.()
    const result = await this.itineraries.readSnapshot(async (transaction) => {
      guard?.()
      const rows = await this.itineraries.findAllAbandoned(userId, { transaction })
      guard?.()
      const summaries = await this.toSummaries(rows, transaction, guard)
      guard?.()
      return summaries
    })
    guard?.()
    return result
  }

  /** Reads a single active itinerary's details. */
  async get(userId: number, itineraryId: number, guard?: () => void): Promise<ItineraryDTO> {
    guard?.()
    const result = await this.itineraries.readSnapshot(async (transaction) => {
      guard?.()
      const itinerary = await this.requireOwned(userId, itineraryId, transaction, guard)
      guard?.()
      const places = await this.places.findAllForItinerary(itinerary.id, { transaction })
      guard?.()
      const legs = await this.legs.findAllForItinerary(itinerary.id, { transaction })
      guard?.()
      return this.toDto(itinerary, places, legs)
    })
    guard?.()
    return result
  }

  /** Creates an itinerary: validate, compute times, then persist places and legs. */
  async create(
    userId: number,
    input: CreateItineraryDTO,
    guard?: () => void
  ): Promise<ItineraryDTO> {
    guard?.()
    const { name, startTime, places, legs } = this.normalize(input)
    const times = this.computeTimes(startTime, places, legs)
    return this.write(async (transaction) => {
      const itinerary = await this.itineraries.create(
        { uuid: randomUUID(), userId, name },
        { transaction }
      )
      guard?.()
      const placeRows = await this.persistPlaces(itinerary.id, places, times, transaction, guard)
      guard?.()
      await this.persistLegs(itinerary.id, placeRows, legs, transaction, guard)
      guard?.()
      const legRows = await this.legs.findAllForItinerary(itinerary.id, { transaction })
      guard?.()
      return this.toDto(itinerary, placeRows, legRows)
    }, guard)
  }

  /** Updates an itinerary: ownership re-check and child-table rebuild share one write transaction. */
  async update(
    userId: number,
    input: UpdateItineraryDTO,
    guard?: () => void
  ): Promise<ItineraryDTO> {
    guard?.()
    const { name, startTime, places, legs } = this.normalize(input)
    const times = this.computeTimes(startTime, places, legs)
    return this.write(async (transaction) => {
      await this.requireOwned(userId, input.itineraryId, transaction, guard)
      guard?.()
      const updated = await this.itineraries.update(input.itineraryId, { name }, { transaction })
      guard?.()
      if (!updated) throw new AppError('Itinerary not found.', 'ITINERARY_NOT_FOUND')
      await this.legs.deleteAllForItinerary(input.itineraryId, { transaction })
      guard?.()
      await this.places.deleteAllForItinerary(input.itineraryId, { transaction })
      guard?.()
      const placeRows = await this.persistPlaces(
        input.itineraryId,
        places,
        times,
        transaction,
        guard
      )
      guard?.()
      await this.persistLegs(input.itineraryId, placeRows, legs, transaction, guard)
      guard?.()
      const itinerary = await this.requireOwned(userId, input.itineraryId, transaction, guard)
      guard?.()
      const legRows = await this.legs.findAllForItinerary(input.itineraryId, { transaction })
      guard?.()
      return this.toDto(itinerary, placeRows, legRows)
    }, guard)
  }

  async softDelete(userId: number, itineraryId: number, guard?: () => void): Promise<boolean> {
    return this.write(async (transaction) => {
      await this.requireOwned(userId, itineraryId, transaction, guard)
      guard?.()
      const result = await this.itineraries.delete(itineraryId, false, { transaction })
      guard?.()
      return result
    }, guard)
  }

  async restore(userId: number, itineraryId: number, guard?: () => void): Promise<boolean> {
    return this.write(async (transaction) => {
      const itinerary = await this.requireAbandoned(userId, itineraryId, transaction, guard)
      guard?.()
      const result = await this.itineraries.restoreAbandoned(itinerary, transaction)
      guard?.()
      return result
    }, guard)
  }

  async purge(userId: number, itineraryId: number, guard?: () => void): Promise<boolean> {
    return this.write(async (transaction) => {
      const itinerary = await this.requireAbandoned(userId, itineraryId, transaction, guard)
      guard?.()
      await this.legs.deleteAllForItinerary(itineraryId, { transaction })
      guard?.()
      await this.places.deleteAllForItinerary(itineraryId, { transaction })
      guard?.()
      const result = await this.itineraries.purgeAbandoned(itinerary, transaction)
      guard?.()
      return result
    }, guard)
  }

  private async write<T>(
    operation: (transaction: Transaction) => Promise<T>,
    guard?: () => void
  ): Promise<T> {
    guard?.()
    const result = await this.itineraries.transaction(async (transaction) => {
      registerTransactionGuard(transaction, guard)
      guard?.()
      const value = await operation(transaction)
      guard?.()
      return value
    })
    guard?.()
    return result
  }

  // ---- Internal helpers ----

  /** Validates and normalizes input, returning the name, anchor time, ordered places and legs. */
  private normalize(input: CreateItineraryDTO | UpdateItineraryDTO): {
    name: string
    startTime: Date
    places: NormalizedPlace[]
    legs: NormalizedLeg[]
  } {
    const name = input.name.trim()
    if (!name) throw new AppError('Itinerary name is required.', 'INVALID_INPUT')

    const startTime = new Date(input.startTime)
    if (Number.isNaN(startTime.getTime())) {
      throw new AppError('Invalid start time.', 'INVALID_INPUT')
    }

    if (input.places.length < ITINERARY_MIN_PLACES || input.places.length > ITINERARY_MAX_PLACES) {
      throw new AppError('An itinerary needs between 2 and 50 places.', 'INVALID_INPUT')
    }
    if (input.legs.length !== input.places.length - 1) {
      throw new AppError('Legs must connect every consecutive place.', 'INVALID_INPUT')
    }

    // Assign each place's role by position (first=start, last=end) and validate stay durations.
    const places: NormalizedPlace[] = input.places.map((place, index) => {
      const trimmed = place.name.trim()
      if (!trimmed) throw new AppError('Place name is required.', 'INVALID_INPUT')
      const role: TransportRole =
        index === 0 ? 'start' : index === input.places.length - 1 ? 'end' : 'middle'
      const stayMinutes = Math.floor(place.stayMinutes ?? 0)
      if (
        !Number.isSafeInteger(stayMinutes) ||
        stayMinutes < 0 ||
        stayMinutes > ITINERARY_MAX_STAY_MINUTES
      ) {
        throw new AppError('Invalid stay time.', 'INVALID_INPUT')
      }
      return { name: trimmed, role, stayMinutes }
    })

    const legs: NormalizedLeg[] = input.legs.map((leg) => {
      const durationMinutes = Math.floor(leg.durationMinutes)
      if (
        !Number.isSafeInteger(durationMinutes) ||
        durationMinutes < 1 ||
        durationMinutes > ITINERARY_MAX_DURATION_MINUTES
      ) {
        throw new AppError('Invalid travel duration.', 'INVALID_INPUT')
      }
      return { mode: leg.mode, durationMinutes }
    })

    return { name, startTime, places, legs }
  }

  /**
   * Computes each place's times: the start point has only a departure time; an
   * intermediate place's arrival = previous departure + travel duration, and
   * its departure = arrival + stay; the end point has only an arrival =
   * previous departure + travel duration.
   */
  private computeTimes(
    startTime: Date,
    places: NormalizedPlace[],
    legs: NormalizedLeg[]
  ): ComputedTimes[] {
    const times: ComputedTimes[] = [{ arrivalTime: null, departureTime: startTime }]
    let departure = startTime
    // Walk the legs forward, accumulating departure + travel + stay into arrival/departure times.
    for (let i = 0; i < legs.length; i++) {
      const arrival = addMinutes(departure, legs[i].durationMinutes)
      const next = places[i + 1]
      const nextDeparture = next.role === 'end' ? null : addMinutes(arrival, next.stayMinutes)
      times.push({ arrivalTime: arrival, departureTime: nextDeparture })
      departure = nextDeparture ?? arrival
    }
    return times
  }

  private async persistPlaces(
    itineraryId: number,
    places: NormalizedPlace[],
    times: ComputedTimes[],
    transaction: Transaction,
    guard?: () => void
  ): Promise<ItineraryPlace[]> {
    guard?.()
    const rows: ItineraryPlace[] = []
    for (let i = 0; i < places.length; i++) {
      const place = places[i]
      const row = await this.places.create(
        {
          itineraryId,
          name: place.name,
          role: place.role,
          sortOrder: i,
          arrivalTime: times[i].arrivalTime,
          departureTime: times[i].departureTime,
          stayMinutes: place.role === 'middle' ? place.stayMinutes : 0
        },
        { transaction }
      )
      guard?.()
      rows.push(row)
    }
    return rows
  }

  private async persistLegs(
    itineraryId: number,
    placeRows: ItineraryPlace[],
    legs: NormalizedLeg[],
    transaction: Transaction,
    guard?: () => void
  ): Promise<void> {
    guard?.()
    for (let i = 0; i < legs.length; i++) {
      await this.legs.create(
        {
          itineraryId,
          fromPlaceId: placeRows[i].id,
          toPlaceId: placeRows[i + 1].id,
          mode: legs[i].mode,
          durationMinutes: legs[i].durationMinutes,
          sortOrder: i
        },
        { transaction }
      )
      guard?.()
    }
  }

  private async requireOwned(
    userId: number,
    itineraryId: number,
    transaction: Transaction,
    guard?: () => void
  ): Promise<Itinerary> {
    guard?.()
    if (!Number.isSafeInteger(itineraryId) || itineraryId <= 0)
      throw new AppError('Invalid itinerary ID.', 'INVALID_INPUT')
    const itinerary = await this.itineraries.findOwnedById(userId, itineraryId, { transaction })
    guard?.()
    if (!itinerary) throw new AppError('Itinerary not found.', 'ITINERARY_NOT_FOUND')
    return itinerary
  }

  private async requireAbandoned(
    userId: number,
    itineraryId: number,
    transaction: Transaction,
    guard?: () => void
  ): Promise<Itinerary> {
    guard?.()
    if (!Number.isSafeInteger(itineraryId) || itineraryId <= 0)
      throw new AppError('Invalid itinerary ID.', 'INVALID_INPUT')
    const itinerary = await this.itineraries.findOwnedById(userId, itineraryId, {
      paranoid: false,
      transaction
    })
    guard?.()
    if (!itinerary || !itinerary.deletedAt) {
      throw new AppError('Itinerary not found in abandoned list.', 'ITINERARY_NOT_FOUND')
    }
    return itinerary
  }

  private async toSummaries(
    rows: Itinerary[],
    transaction: Transaction,
    guard?: () => void
  ): Promise<ItinerarySummaryDTO[]> {
    guard?.()
    const ids = rows.map((row) => row.id)
    const allPlaces = await this.places.findAllForItineraries(ids, { transaction })
    guard?.()
    const grouped = new Map<number, ItineraryPlace[]>()
    for (const place of allPlaces) {
      const list = grouped.get(place.itineraryId) ?? []
      list.push(place)
      grouped.set(place.itineraryId, list)
    }
    return rows.map((row) => this.toSummary(row, grouped.get(row.id) ?? []))
  }

  private toSummary(itinerary: Itinerary, places: ItineraryPlace[]): ItinerarySummaryDTO {
    const sorted = [...places].sort((a, b) => a.sortOrder - b.sortOrder)
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    return {
      id: itinerary.id,
      uuid: itinerary.uuid,
      name: itinerary.name,
      startTime: first?.departureTime?.toISOString() ?? null,
      endTime: last?.arrivalTime?.toISOString() ?? null,
      startPlaceName: first?.name ?? null,
      endPlaceName: last?.name ?? null,
      placeCount: sorted.length,
      createdAt: itinerary.createdAt.toISOString(),
      updatedAt: itinerary.updatedAt.toISOString(),
      deletedAt: itinerary.deletedAt ? itinerary.deletedAt.toISOString() : null
    }
  }

  private toDto(
    itinerary: Itinerary,
    places: ItineraryPlace[],
    legs: ItineraryLeg[]
  ): ItineraryDTO {
    const sortedPlaces = [...places].sort((a, b) => a.sortOrder - b.sortOrder)
    const sortedLegs = [...legs].sort((a, b) => a.sortOrder - b.sortOrder)
    const first = sortedPlaces[0]
    const last = sortedPlaces[sortedPlaces.length - 1]
    return {
      id: itinerary.id,
      uuid: itinerary.uuid,
      name: itinerary.name,
      places: sortedPlaces.map((place) => ({
        id: place.id,
        name: place.name,
        role: place.role,
        sortOrder: place.sortOrder,
        arrivalTime: place.arrivalTime ? place.arrivalTime.toISOString() : null,
        departureTime: place.departureTime ? place.departureTime.toISOString() : null,
        stayMinutes: place.stayMinutes
      })),
      legs: sortedLegs.map((leg) => ({
        id: leg.id,
        fromPlaceId: leg.fromPlaceId,
        toPlaceId: leg.toPlaceId,
        mode: leg.mode,
        durationMinutes: leg.durationMinutes,
        sortOrder: leg.sortOrder
      })),
      startTime: first?.departureTime?.toISOString() ?? null,
      endTime: last?.arrivalTime?.toISOString() ?? null,
      createdAt: itinerary.createdAt.toISOString(),
      updatedAt: itinerary.updatedAt.toISOString()
    }
  }
}

/** Adds a number of minutes to a date. */
function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MINUTE_MS)
}

export default ItineraryService
