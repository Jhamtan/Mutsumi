import 'reflect-metadata'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
import ItineraryRepository from '../../../src/main/database/repositories/ItineraryRepository'
import ItineraryPlaceRepository from '../../../src/main/database/repositories/ItineraryPlaceRepository'
import ItineraryLegRepository from '../../../src/main/database/repositories/ItineraryLegRepository'
import ItineraryService from '../../../src/main/services/ItineraryService'

const input = {
  name: '安全测试行程',
  startTime: '2026-11-12T09:00:00.000Z',
  places: [{ name: '起点' }, { name: '终点' }],
  legs: [{ mode: 'car' as const, durationMinutes: 30 }]
}
const models = [User, Notebook, Diary, DiaryImage, Itinerary, ItineraryPlace, ItineraryLeg]

describe('行程安全与删除竞态', () => {
  let database: Sequelize
  let userId: number
  let otherUserId: number
  let itineraries: ItineraryRepository
  let places: ItineraryPlaceRepository
  let legs: ItineraryLegRepository
  let service: ItineraryService

  beforeAll(async () => {
    database = new Sequelize({ dialect: 'sqlite', storage: ':memory:', models, logging: false })
    await database.sync({ force: true })
    const users = new UserRepository()
    userId = (
      await users.create({
        name: 'Owner',
        email: 'trip-security@example.com',
        password: 'owner-pass'
      })
    ).id
    otherUserId = (
      await users.create({ name: 'Other', email: 'trip-other@example.com', password: 'other-pass' })
    ).id
  })
  beforeEach(() => {
    itineraries = new ItineraryRepository()
    places = new ItineraryPlaceRepository()
    legs = new ItineraryLegRepository()
    service = new ItineraryService(itineraries, places, legs)
  })
  afterAll(async () => {
    await database.close()
  })

  it('get 与摘要列表的多表读取共享一致快照', async () => {
    const created = await service.create(userId, input)
    const owned = vi.spyOn(itineraries, 'findOwnedById')
    const place = vi.spyOn(places, 'findAllForItinerary')
    const leg = vi.spyOn(legs, 'findAllForItinerary')
    await service.get(userId, created.id)
    const transaction = owned.mock.calls[0][2]?.transaction
    expect(transaction).toBeDefined()
    expect(place.mock.calls[0][1]?.transaction).toBe(transaction)
    expect(leg.mock.calls[0][1]?.transaction).toBe(transaction)
    const list = vi.spyOn(itineraries, 'findAllOwned')
    const grouped = vi.spyOn(places, 'findAllForItineraries')
    await service.list(userId)
    expect(list.mock.calls[0][1]?.transaction).toBeDefined()
    expect(grouped.mock.calls[0][1]?.transaction).toBe(list.mock.calls[0][1]?.transaction)
  })

  it('restore 先成功时，随后取得写锁的旧 purge 请求不能删掉已恢复行程', async () => {
    const created = await service.create(userId, input)
    await service.softDelete(userId, created.id)
    const original = itineraries.transaction.bind(itineraries)
    vi.spyOn(itineraries, 'transaction').mockImplementationOnce(async (operation, options) => {
      // 模拟 purge 等待写锁期间另一个会话先完成恢复。
      await new ItineraryService().restore(userId, created.id)
      return original(operation, options)
    })
    await expect(service.purge(userId, created.id)).rejects.toMatchObject({
      code: 'ITINERARY_NOT_FOUND'
    })
    expect((await service.get(userId, created.id)).places).toHaveLength(2)
    expect(await ItineraryLeg.count({ where: { itineraryId: created.id } })).toBe(1)
  })

  it('purge 先完成时，随后 restore 不得报告恢复成功', async () => {
    const created = await service.create(userId, input)
    await service.softDelete(userId, created.id)
    const original = itineraries.transaction.bind(itineraries)
    vi.spyOn(itineraries, 'transaction').mockImplementationOnce(async (operation, options) => {
      await new ItineraryService().purge(userId, created.id)
      return original(operation, options)
    })
    await expect(service.restore(userId, created.id)).rejects.toMatchObject({
      code: 'ITINERARY_NOT_FOUND'
    })
    expect(await Itinerary.findByPk(created.id, { paranoid: false })).toBeNull()
  })

  it('最终父删除 SQL 检查 deletedAt，状态变化时子表删除一起回滚', async () => {
    const created = await service.create(userId, input)
    await service.softDelete(userId, created.id)
    const original = itineraries.purgeAbandoned.bind(itineraries)
    vi.spyOn(itineraries, 'purgeAbandoned').mockImplementationOnce(async (row, transaction) => {
      await Itinerary.update(
        { deletedAt: null },
        { where: { id: row.id }, paranoid: false, transaction }
      )
      return original(row, transaction)
    })
    await expect(service.purge(userId, created.id)).rejects.toMatchObject({ code: 'DATA_CONFLICT' })
    expect((await Itinerary.findByPk(created.id, { paranoid: false }))?.deletedAt).not.toBeNull()
    expect(await ItineraryPlace.count({ where: { itineraryId: created.id } })).toBe(2)
    expect(await ItineraryLeg.count({ where: { itineraryId: created.id } })).toBe(1)
  })

  it('restore/purge/update 都在写事务内重新复核归属与状态', async () => {
    const created = await service.create(userId, input)
    const load = vi.spyOn(itineraries, 'findOwnedById')
    await service.update(userId, { ...input, itineraryId: created.id })
    await service.softDelete(userId, created.id)
    await expect(service.restore(otherUserId, created.id)).rejects.toMatchObject({
      code: 'ITINERARY_NOT_FOUND'
    })
    await expect(service.purge(otherUserId, created.id)).rejects.toMatchObject({
      code: 'ITINERARY_NOT_FOUND'
    })
    await service.restore(userId, created.id)
    expect(load.mock.calls.every((call) => call[2]?.transaction !== undefined)).toBe(true)
    await expect(service.purge(userId, created.id)).rejects.toMatchObject({
      code: 'ITINERARY_NOT_FOUND'
    })
  })

  it('子表写入后会话失效，创建事务整体回滚', async () => {
    let valid = true
    const before = await Itinerary.count()
    ItineraryPlace.addHook('afterCreate', 'invalidate-trip-session', () => {
      valid = false
    })
    try {
      await expect(
        service.create(userId, input, () => {
          if (!valid) throw new Error('会话失效')
        })
      ).rejects.toThrow()
      expect(await Itinerary.count()).toBe(before)
    } finally {
      ItineraryPlace.removeHook('afterCreate', 'invalidate-trip-session')
    }
  })

  it('外层事务 callback 返回前失效，已完成的 service 写入仍会回滚', async () => {
    let valid = true
    const before = await Itinerary.count()
    await expect(
      itineraries.transaction(async () => {
        await service.create(userId, input, () => {
          if (!valid) throw new Error('会话失效')
        })
        valid = false
      })
    ).rejects.toThrow()
    expect(await Itinerary.count()).toBe(before)
  })

  it('get 在 await 后会话失效，不返回敏感地点与出行段', async () => {
    const created = await service.create(userId, input)
    let valid = true
    const original = places.findAllForItinerary.bind(places)
    vi.spyOn(places, 'findAllForItinerary').mockImplementationOnce(async (...args) => {
      const result = await original(...args)
      valid = false
      return result
    })
    const leg = vi.spyOn(legs, 'findAllForItinerary')
    await expect(
      service.get(userId, created.id, () => {
        if (!valid) throw new Error('会话失效')
      })
    ).rejects.toThrow()
    expect(leg).not.toHaveBeenCalled()
  })
})
