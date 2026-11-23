import 'reflect-metadata'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Sequelize } from 'sequelize-typescript'

vi.mock('../../../src/main/logger', () => ({ default: { error: vi.fn() } }))
import { User } from '../../../src/main/database/models/user.model'
import { Notebook } from '../../../src/main/database/models/notebook.model'
import { Diary } from '../../../src/main/database/models/diary.model'
import { DiaryImage } from '../../../src/main/database/models/diary-image.model'
import { Itinerary } from '../../../src/main/database/models/itinerary.model'
import { ItineraryPlace } from '../../../src/main/database/models/itinerary-place.model'
import { ItineraryLeg } from '../../../src/main/database/models/itinerary-leg.model'
import UserRepository from '../../../src/main/database/repositories/UserRepository'
import ItineraryService from '../../../src/main/services/ItineraryService'

/**
 * Integration test for ItineraryService on in-memory SQLite: time derivation,
 * CRUD, soft-delete/restore/purge lifecycle, ownership checks and validation.
 */
// 模型间存在关联链（User→Notebook→Diary→DiaryImage），需一并注册以满足关联解析。
const models = [User, Notebook, Diary, DiaryImage, Itinerary, ItineraryPlace, ItineraryLeg]

function createDatabase(): Sequelize {
  return new Sequelize({ dialect: 'sqlite', storage: ':memory:', models, logging: false })
}

describe('ItineraryService', () => {
  let database: Sequelize
  let userId: number
  let otherUserId: number
  let service: ItineraryService

  beforeAll(async () => {
    database = createDatabase()
    await database.sync({ force: true })
    const users = new UserRepository()
    userId = (
      await users.create({ name: 'Owner', email: 'owner@example.com', password: 'owner-pass' })
    ).id
    otherUserId = (
      await users.create({ name: 'Other', email: 'other@example.com', password: 'other-pass' })
    ).id
    service = new ItineraryService()
  })

  afterAll(async () => {
    await database?.close()
  })

  it('derives times for a two-place trip: start departure, end arrival', async () => {
    const dto = await service.create(userId, {
      name: '两点一线',
      startTime: '2026-11-12T09:00:00.000Z',
      places: [{ name: '家' }, { name: '公司' }],
      legs: [{ mode: 'car', durationMinutes: 30 }]
    })

    expect(dto.places).toHaveLength(2)
    expect(dto.places[0].role).toBe('start')
    expect(dto.places[0].arrivalTime).toBeNull()
    expect(dto.places[0].departureTime).toBe('2026-11-12T09:00:00.000Z')
    expect(dto.places[1].role).toBe('end')
    expect(dto.places[1].departureTime).toBeNull()
    expect(dto.places[1].arrivalTime).toBe('2026-11-12T09:30:00.000Z')
    expect(dto.startTime).toBe('2026-11-12T09:00:00.000Z')
    expect(dto.endTime).toBe('2026-11-12T09:30:00.000Z')
    expect(dto.legs).toHaveLength(1)
    expect(dto.legs[0].mode).toBe('car')
  })

  it('derives middle-place arrival, stay and departure times', async () => {
    const dto = await service.create(userId, {
      name: '含中途停留',
      startTime: '2026-11-12T09:00:00.000Z',
      places: [{ name: '家' }, { name: '咖啡店', stayMinutes: 20 }, { name: '公司' }],
      legs: [
        { mode: 'subway', durationMinutes: 30 },
        { mode: 'walk', durationMinutes: 15 }
      ]
    })

    const [start, middle, end] = dto.places
    expect(start.departureTime).toBe('2026-11-12T09:00:00.000Z')
    expect(middle.arrivalTime).toBe('2026-11-12T09:30:00.000Z')
    expect(middle.departureTime).toBe('2026-11-12T09:50:00.000Z')
    expect(middle.stayMinutes).toBe(20)
    expect(end.arrivalTime).toBe('2026-11-12T10:05:00.000Z')
  })

  it('treats a zero stay as arrival equal to departure', async () => {
    const dto = await service.create(userId, {
      name: '零停留',
      startTime: '2026-11-12T08:00:00.000Z',
      places: [{ name: '家' }, { name: '中转' }, { name: '公司' }],
      legs: [
        { mode: 'bus', durationMinutes: 20 },
        { mode: 'bus', durationMinutes: 10 }
      ]
    })

    const middle = dto.places[1]
    expect(middle.stayMinutes).toBe(0)
    expect(middle.arrivalTime).toBe(middle.departureTime)
    expect(middle.arrivalTime).toBe('2026-11-12T08:20:00.000Z')
  })

  it('lists summaries and returns ordered places and legs on get', async () => {
    const summaries = await service.list(userId)
    expect(summaries.length).toBeGreaterThanOrEqual(3)
    const sample = summaries.find((s) => s.name === '含中途停留')!
    expect(sample.startPlaceName).toBe('家')
    expect(sample.endPlaceName).toBe('公司')
    expect(sample.placeCount).toBe(3)

    const dto = await service.get(userId, sample.id)
    expect(dto.places.map((p) => p.name)).toEqual(['家', '咖啡店', '公司'])
    expect(dto.legs.map((l) => l.mode)).toEqual(['subway', 'walk'])
  })

  it('updates an itinerary and recomputes times', async () => {
    const created = await service.create(userId, {
      name: '待更新',
      startTime: '2026-11-12T09:00:00.000Z',
      places: [{ name: '家' }, { name: '公司' }],
      legs: [{ mode: 'car', durationMinutes: 30 }]
    })

    const updated = await service.update(userId, {
      itineraryId: created.id,
      name: '已更新',
      startTime: '2026-11-12T10:00:00.000Z',
      places: [{ name: '家' }, { name: '商场', stayMinutes: 45 }, { name: '公司' }],
      legs: [
        { mode: 'taxi', durationMinutes: 20 },
        { mode: 'subway', durationMinutes: 15 }
      ]
    })

    expect(updated.name).toBe('已更新')
    expect(updated.places.map((p) => p.name)).toEqual(['家', '商场', '公司'])
    expect(updated.places[1].arrivalTime).toBe('2026-11-12T10:20:00.000Z')
    expect(updated.places[1].departureTime).toBe('2026-11-12T11:05:00.000Z')
    expect(updated.places[2].arrivalTime).toBe('2026-11-12T11:20:00.000Z')
    // 重建后旧地点与出行段已被清理
    expect(await ItineraryPlace.count({ where: { itineraryId: created.id } })).toBe(3)
  })

  it('soft-deletes into abandoned, restores, then purges permanently', async () => {
    const created = await service.create(userId, {
      name: '生命周期',
      startTime: '2026-11-12T09:00:00.000Z',
      places: [{ name: '家' }, { name: '公司' }],
      legs: [{ mode: 'car', durationMinutes: 30 }]
    })

    await service.softDelete(userId, created.id)
    expect(await service.list(userId)).not.toContainEqual(
      expect.objectContaining({ id: created.id })
    )
    const abandoned = await service.listAbandoned(userId)
    expect(abandoned).toContainEqual(expect.objectContaining({ id: created.id, name: '生命周期' }))

    await service.restore(userId, created.id)
    expect(await service.list(userId)).toContainEqual(expect.objectContaining({ id: created.id }))
    expect(await service.listAbandoned(userId)).not.toContainEqual(
      expect.objectContaining({ id: created.id })
    )

    // 再次软删除后彻底删除
    await service.softDelete(userId, created.id)
    await service.purge(userId, created.id)
    expect(await Itinerary.findByPk(created.id, { paranoid: false })).toBeNull()
    expect(await ItineraryPlace.count({ where: { itineraryId: created.id } })).toBe(0)
    expect(await ItineraryLeg.count({ where: { itineraryId: created.id } })).toBe(0)
  })

  it('rejects access by a non-owner', async () => {
    const created = await service.create(userId, {
      name: '越权校验',
      startTime: '2026-11-12T09:00:00.000Z',
      places: [{ name: '家' }, { name: '公司' }],
      legs: [{ mode: 'car', durationMinutes: 30 }]
    })

    await expect(service.get(otherUserId, created.id)).rejects.toMatchObject({
      code: 'ITINERARY_NOT_FOUND'
    })
    await expect(service.softDelete(otherUserId, created.id)).rejects.toMatchObject({
      code: 'ITINERARY_NOT_FOUND'
    })
    await expect(
      service.update(otherUserId, {
        itineraryId: created.id,
        name: '篡改',
        startTime: '2026-11-12T09:00:00.000Z',
        places: [{ name: 'A' }, { name: 'B' }],
        legs: [{ mode: 'car', durationMinutes: 10 }]
      })
    ).rejects.toMatchObject({ code: 'ITINERARY_NOT_FOUND' })
  })

  it('rejects malformed input', async () => {
    await expect(
      service.create(userId, {
        name: ' ',
        startTime: '2026-11-12T09:00:00.000Z',
        places: [{ name: '家' }, { name: '公司' }],
        legs: [{ mode: 'car', durationMinutes: 30 }]
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    await expect(
      service.create(userId, {
        name: '缺终点',
        startTime: '2026-11-12T09:00:00.000Z',
        places: [{ name: '家' }],
        legs: []
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    await expect(
      service.create(userId, {
        name: '耗时非法',
        startTime: '2026-11-12T09:00:00.000Z',
        places: [{ name: '家' }, { name: '公司' }],
        legs: [{ mode: 'car', durationMinutes: 0 }]
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})
