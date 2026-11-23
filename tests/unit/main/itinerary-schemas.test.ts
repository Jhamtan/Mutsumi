import { describe, expect, it } from 'vitest'
import {
  CreateItinerarySchema,
  UpdateItinerarySchema,
  ItineraryIdSchema
} from '../../../src/main/ipc/schemas'

/**
 * Validates the itinerary Zod schemas: place/leg count consistency, transport
 * mode whitelist, duration/stay bounds, and strict field stripping.
 */
const validBody = {
  name: '周末城市漫游',
  startTime: '2026-11-12T09:00:00.000Z',
  places: [{ name: '家' }, { name: '咖啡店', stayMinutes: 20 }, { name: '公司' }],
  legs: [
    { mode: 'subway', durationMinutes: 30 },
    { mode: 'walk', durationMinutes: 15 }
  ]
}

const allModes = ['car', 'taxi', 'subway', 'bus', 'bike', 'walk', 'train', 'plane']

describe('CreateItinerarySchema', () => {
  it('accepts a valid itinerary', () => {
    expect(CreateItinerarySchema.parse(validBody)).toEqual(validBody)
  })

  it('rejects fields outside the strict contract', () => {
    expect(CreateItinerarySchema.safeParse({ ...validBody, id: 99, role: 'admin' }).success).toBe(
      false
    )
  })

  it('accepts every supported transport mode', () => {
    for (const mode of allModes) {
      const body = {
        ...validBody,
        legs: [{ mode, durationMinutes: 30 }],
        places: [{ name: '家' }, { name: '公司' }]
      }
      expect(CreateItinerarySchema.safeParse(body).success, mode).toBe(true)
    }
  })

  it.each(['', 'rocket', 'CAR', 'drive'])('rejects an unsupported mode: %j', (mode) => {
    const body = {
      ...validBody,
      legs: [{ mode, durationMinutes: 30 }],
      places: [{ name: '家' }, { name: '公司' }]
    }
    expect(CreateItinerarySchema.safeParse(body).success).toBe(false)
  })

  it('rejects fewer than two places', () => {
    const body = {
      ...validBody,
      places: [{ name: '家' }],
      legs: []
    }
    expect(CreateItinerarySchema.safeParse(body).success).toBe(false)
  })

  it('rejects a leg count that does not connect every place', () => {
    expect(
      CreateItinerarySchema.safeParse({
        ...validBody,
        places: [{ name: '家' }, { name: '公司' }]
      }).success
    ).toBe(false)
  })

  it('rejects non-positive or oversized travel durations', () => {
    for (const durationMinutes of [0, -1, 1.5, 10081]) {
      const body = {
        ...validBody,
        legs: [{ mode: 'car', durationMinutes }],
        places: [{ name: '家' }, { name: '公司' }]
      }
      expect(CreateItinerarySchema.safeParse(body).success, String(durationMinutes)).toBe(false)
    }
  })

  it('rejects negative or oversized stay times', () => {
    for (const stayMinutes of [-1, 10081, 1.5]) {
      const body = {
        ...validBody,
        places: [{ name: '家' }, { name: '咖啡店', stayMinutes }, { name: '公司' }]
      }
      expect(CreateItinerarySchema.safeParse(body).success, String(stayMinutes)).toBe(false)
    }
  })

  it('rejects an invalid start time', () => {
    expect(CreateItinerarySchema.safeParse({ ...validBody, startTime: 'not-a-date' }).success).toBe(
      false
    )
  })
})

describe('UpdateItinerarySchema', () => {
  it('requires a positive itinerary id', () => {
    expect(UpdateItinerarySchema.safeParse({ ...validBody, itineraryId: 7 }).success).toBe(true)
    expect(UpdateItinerarySchema.safeParse({ ...validBody }).success).toBe(false)
    expect(UpdateItinerarySchema.safeParse({ ...validBody, itineraryId: 0 }).success).toBe(false)
  })
})

describe('ItineraryIdSchema', () => {
  it('accepts a positive id and rejects missing or invalid ids', () => {
    expect(ItineraryIdSchema.safeParse({ itineraryId: 1 }).success).toBe(true)
    expect(ItineraryIdSchema.safeParse({}).success).toBe(false)
    expect(ItineraryIdSchema.safeParse({ itineraryId: 0 }).success).toBe(false)
    expect(ItineraryIdSchema.safeParse({ itineraryId: -3 }).success).toBe(false)
  })
})
