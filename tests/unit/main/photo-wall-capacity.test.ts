import 'reflect-metadata'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sequelize } from 'sequelize-typescript'
import sharp from 'sharp'
import * as yauzl from 'yauzl'
import { AppError } from '../../../src/main/errors'
import { PhotoWallLimitsSchema } from '../../../src/main/ipc/schemas'
import PhotoWallLimitsService, {
  type PhotoWallLimitsStore
} from '../../../src/main/services/PhotoWallLimitsService'
import PhotoWallService from '../../../src/main/services/PhotoWallService'
import PhotoWallRepository from '../../../src/main/database/repositories/PhotoWallRepository'
import PhotoWallImageRepository from '../../../src/main/database/repositories/PhotoWallImageRepository'
import UserRepository from '../../../src/main/database/repositories/UserRepository'
import { User } from '../../../src/main/database/models/user.model'
import { Notebook } from '../../../src/main/database/models/notebook.model'
import { Diary } from '../../../src/main/database/models/diary.model'
import { DiaryImage } from '../../../src/main/database/models/diary-image.model'
import { Itinerary } from '../../../src/main/database/models/itinerary.model'
import { ItineraryPlace } from '../../../src/main/database/models/itinerary-place.model'
import { ItineraryLeg } from '../../../src/main/database/models/itinerary-leg.model'
import { PhotoWall } from '../../../src/main/database/models/photowall.model'
import { PhotoWallImage } from '../../../src/main/database/models/photowall-image.model'

vi.mock('../../../src/main/logger', () => ({ default: { error: vi.fn() } }))
vi.mock('electron-store', () => ({
  default: class {
    constructor() {
      throw new Error('测试不得访问真实用户存储')
    }
  }
}))

const MiB = 1024 * 1024
const defaults = { imageMaxBytes: 5 * MiB, totalMaxBytes: 64 * MiB }
const models = [
  User,
  Notebook,
  Diary,
  DiaryImage,
  Itinerary,
  ItineraryPlace,
  ItineraryLeg,
  PhotoWall,
  PhotoWallImage
]
const temporaryRoot = fileURLToPath(new URL('../../../outputs/security-test-tmp/', import.meta.url))

class MemoryStore implements PhotoWallLimitsStore {
  values = new Map<string, unknown>()
  get(key: string) {
    return this.values.get(key)
  }
  set(key: string, value: unknown) {
    this.values.set(key, structuredClone(value))
  }
  delete(key: string) {
    this.values.delete(key)
  }
}

/** 合法 APP15 metadata 增大源文件，实际像素仍为 2×2，完整图片由 sharp 生成并解码。 */
async function metadataImage(minimumBytes: number): Promise<Buffer> {
  const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#aabbcc' } })
    .jpeg()
    .toBuffer()
  const chunks: Buffer[] = [jpeg.subarray(0, 2)]
  let size = jpeg.length
  while (size < minimumBytes) {
    const payload = Math.min(65_533, minimumBytes - size)
    const segment = Buffer.alloc(payload + 4)
    segment.writeUInt16BE(0xffef, 0)
    segment.writeUInt16BE(payload + 2, 2)
    chunks.push(segment)
    size += segment.length
  }
  chunks.push(jpeg.subarray(2))
  const result = Buffer.concat(chunks)
  for (const chunk of chunks.slice(1, -1)) chunk.fill(0)
  jpeg.fill(0)
  return result
}

async function inspectZip(path: string, expected: Buffer, count: number): Promise<void> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (error, value) =>
      error || !value ? reject(error) : resolve(value)
    )
  })
  let photos = 0
  let preview = false
  const hash = createHash('sha256').update(expected).digest('hex')
  await new Promise<void>((resolve, reject) => {
    zip.on('error', reject)
    zip.on('end', resolve)
    zip.on('entry', (entry: yauzl.Entry) => {
      const image = entry.fileName.startsWith('images/photo_') || entry.fileName === 'preview.jpg'
      if (!image) {
        zip.readEntry()
        return
      }
      if (entry.fileName === 'preview.jpg') preview = true
      else photos++
      expect(entry.uncompressedSize).toBe(expected.length)
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          reject(error)
          return
        }
        const digest = createHash('sha256')
        let bytes = 0
        stream.on('error', reject)
        stream.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          digest.update(chunk)
        })
        stream.on('end', () => {
          try {
            expect(bytes).toBe(expected.length)
            expect(digest.digest('hex')).toBe(hash)
            zip.readEntry()
          } catch (failure) {
            zip.close()
            reject(failure)
          }
        })
      })
    })
    zip.readEntry()
  })
  expect(photos).toBe(count)
  expect(preview).toBe(true)
}

describe('照片墙账号容量存储', () => {
  it('模块与默认构造不访问用户目录，默认 5/64 MiB', () => {
    expect(() => new PhotoWallLimitsService()).not.toThrow()
    expect(new PhotoWallLimitsService(new MemoryStore()).get(1)).toEqual(defaults)
  })

  it('严格整 MiB，拒绝弱/无限/超硬上限及额外字段；损坏设置回退默认', () => {
    const store = new MemoryStore()
    const service = new PhotoWallLimitsService(store)
    for (const bad of [
      { ...defaults, imageMaxBytes: 0 },
      { ...defaults, imageMaxBytes: MiB - 1 },
      { ...defaults, imageMaxBytes: 6 * MiB + 1 },
      { ...defaults, imageMaxBytes: 11 * MiB },
      { ...defaults, imageMaxBytes: Infinity },
      { ...defaults, imageMaxBytes: NaN },
      { ...defaults, totalMaxBytes: 63 * MiB },
      { ...defaults, totalMaxBytes: 513 * MiB },
      { ...defaults, totalMaxBytes: Infinity },
      { ...defaults, path: 'private' }
    ]) {
      expect(PhotoWallLimitsSchema.safeParse(bad).success).toBe(false)
      expect(() => service.set(1, bad)).toThrow()
      store.values.set('users.1', bad)
      expect(service.get(1)).toEqual(defaults)
    }
    expect(() => service.get(0)).toThrow()
  })

  it('各账号隔离并通过相同 fake store 跨实例持久化', () => {
    const store = new MemoryStore()
    const service = new PhotoWallLimitsService(store)
    const limits = { imageMaxBytes: 10 * MiB, totalMaxBytes: 512 * MiB }
    expect(service.set(1, limits)).toEqual(limits)
    expect(service.get(2)).toEqual(defaults)
    expect(new PhotoWallLimitsService(store).get(1)).toEqual(limits)
  })

  it('保存前取消不写，保存内取消恢复旧设置，磁盘失败不伪成功', () => {
    const store = new MemoryStore()
    const service = new PhotoWallLimitsService(store)
    const cancelled = new AppError('已取消', 'OPERATION_CANCELLED')
    const write = vi.spyOn(store, 'set')
    expect(() =>
      service.set(1, defaults, () => {
        throw cancelled
      })
    ).toThrow(cancelled)
    expect(write).not.toHaveBeenCalled()
    service.set(1, defaults)
    let active = true
    const original = store.set.bind(store)
    write.mockImplementationOnce((...args) => {
      original(...args)
      active = false
    })
    expect(() =>
      service.set(1, { ...defaults, totalMaxBytes: 128 * MiB }, () => {
        if (!active) throw cancelled
      })
    ).toThrow(cancelled)
    expect(service.get(1)).toEqual(defaults)
    write.mockImplementationOnce(() => {
      throw new Error('合成保存失败')
    })
    expect(() => service.set(1, { ...defaults, totalMaxBytes: 128 * MiB })).toThrow('合成保存失败')
    expect(service.get(1)).toEqual(defaults)
    write.mockRestore()
  })
})

describe('照片墙实际容量、分页与流式导出', () => {
  let database: Sequelize
  let userId: number
  let otherId: number
  let wallId: number
  let images: PhotoWallImageRepository
  let service: PhotoWallService
  let source: Buffer
  let encoded: string
  const limits = { imageMaxBytes: 6 * MiB, totalMaxBytes: 128 * MiB }

  beforeAll(async () => {
    database = new Sequelize({ dialect: 'sqlite', storage: ':memory:', models, logging: false })
    await database.sync()
    const users = new UserRepository()
    userId = (
      await users.create({
        name: 'FakeOwner',
        email: 'capacity-fake@example.com',
        password: 'fake-pass'
      })
    ).id
    otherId = (
      await users.create({
        name: 'FakeOther',
        email: 'capacity-other@example.com',
        password: 'fake-pass'
      })
    ).id
    wallId = (await new PhotoWallRepository().create({ userId })).id
    source = await metadataImage(5 * MiB + 32 * 1024)
    encoded = `data:image/jpeg;base64,${source.toString('base64')}`
  })
  beforeEach(async () => {
    await PhotoWallImage.destroy({ where: { photoWallId: wallId }, force: true })
    images = new PhotoWallImageRepository()
    service = new PhotoWallService(new PhotoWallRepository(), images)
  })
  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    source?.fill(0)
    encoded = ''
    await database?.close()
  })

  it('6/10 MiB 允许有效超过默认的图片，调小单图仍可读旧图并导出', async () => {
    await expect(service.addPhotos(userId, [encoded])).rejects.toMatchObject({
      code: 'IMAGE_TOO_LARGE'
    })
    expect(await service.addPhotos(userId, [encoded], undefined, limits)).toEqual({
      added: 1,
      photoCount: 1
    })
    const larger = await metadataImage(9 * MiB)
    try {
      await service.addPhotos(
        userId,
        [`data:image/jpeg;base64,${larger.toString('base64')}`],
        undefined,
        {
          imageMaxBytes: 10 * MiB,
          totalMaxBytes: 128 * MiB
        }
      )
    } finally {
      larger.fill(0)
    }
    const lower = { imageMaxBytes: MiB, totalMaxBytes: 128 * MiB }
    expect((await service.getState(userId, undefined, lower)).photoCount).toBe(2)
    expect(await service.listPhotos(userId)).toHaveLength(2)
    const page = await service.listPhotoPage(userId, {}, undefined, lower)
    expect(page.items).toHaveLength(2)
    const directory = await mkdtemp(join(temporaryRoot, 'capacity-lower-'))
    try {
      expect(
        await service.exportWallpaper(userId, join(directory, 'wall.zip'), undefined, lower)
      ).toEqual({ photoCount: 2 })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([128 * MiB, 512 * MiB])(
    '实际超过 64 MiB 保存于 %s 字节配置并逐图导出，分页只读十条，旧原图聚合拒绝',
    async (totalMaxBytes) => {
      const defaultTotal = { ...limits, totalMaxBytes: 64 * MiB }
      for (let batch = 0; batch < 3; batch++)
        await service.addPhotos(userId, Array(4).fill(encoded), undefined, defaultTotal)
      await expect(
        service.addPhotos(userId, [encoded], undefined, defaultTotal)
      ).rejects.toMatchObject({ code: 'PHOTOWALL_CAPACITY_EXCEEDED' })
      expect(await images.countForWall(wallId)).toBe(12)
      await service.addPhotos(userId, [encoded], undefined, { ...limits, totalMaxBytes })
      const load = vi.spyOn(images, 'findForWall')
      const all = vi.spyOn(images, 'findAllForWall')
      expect(await service.getUsage(userId)).toBe(source.length * 13)
      expect(source.length * 13).toBeGreaterThan(64 * MiB)
      expect(load).not.toHaveBeenCalled()
      expect(all).not.toHaveBeenCalled()
      await expect(service.listPhotos(userId)).rejects.toMatchObject({
        code: 'PHOTOWALL_CAPACITY_EXCEEDED'
      })
      expect(load).not.toHaveBeenCalled()
      const first = await service.listPhotoPage(userId, {}, undefined, limits)
      expect(load).toHaveBeenCalledTimes(10)
      expect(first.total).toBe(13)
      expect(first.nextCursor).toBe(first.items[9].id)
      expect(first.items.map((image) => image.id)).toEqual(
        [...first.items.map((image) => image.id)].sort((a, b) => a - b)
      )
      for (const image of first.items) {
        expect(image.sourceHash).toBe(createHash('sha256').update(source).digest('hex'))
        const preview = Buffer.from(image.dataUrl.split(',')[1], 'base64')
        try {
          expect(preview.length).toBeLessThanOrEqual(128 * 1024)
          const metadata = await sharp(preview).metadata()
          expect(Math.max(metadata.width!, metadata.height!)).toBeLessThanOrEqual(640)
        } finally {
          preview.fill(0)
        }
      }
      load.mockClear()
      const last = await service.listPhotoPage(
        userId,
        { afterId: first.nextCursor! },
        undefined,
        limits
      )
      expect(load).toHaveBeenCalledTimes(3)
      expect(last.items).toHaveLength(3)
      expect(last.nextCursor).toBeNull()
      expect(all).not.toHaveBeenCalled()
      const directory = await mkdtemp(join(temporaryRoot, 'capacity-large-'))
      try {
        for (const totalMaxBytes of [128 * MiB, 512 * MiB]) {
          load.mockClear()
          const path = join(directory, `wall-${totalMaxBytes}.zip`)
          expect(
            await service.exportWallpaper(userId, path, undefined, { ...limits, totalMaxBytes })
          ).toEqual({ photoCount: 13 })
          expect(load).toHaveBeenCalledTimes(14)
          await inspectZip(path, source, 13)
        }
        load.mockClear()
        let active = true
        const original = PhotoWallImageRepository.prototype.findForWall.bind(images)
        load.mockImplementation(async (...args) => {
          const row = await original(...args)
          if (load.mock.calls.length === 2) active = false
          return row
        })
        await expect(
          service.exportWallpaper(
            userId,
            join(directory, 'cancelled.zip'),
            () => {
              if (!active) throw new AppError('已取消', 'OPERATION_CANCELLED')
            },
            { ...limits, totalMaxBytes: 512 * MiB }
          )
        ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
        expect((await readdir(directory)).sort()).toEqual(
          [`wall-${128 * MiB}.zip`, `wall-${512 * MiB}.zip`].sort()
        )
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
    120_000
  )

  it('512 MiB 配置不放宽 25 MiB 单批或 200 张，分页非法 cursor 和归属不能穿透', async () => {
    const highest = { imageMaxBytes: 10 * MiB, totalMaxBytes: 512 * MiB }
    await expect(
      service.addPhotos(userId, Array(5).fill(encoded), undefined, highest)
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      service.addPhotos(userId, Array(201).fill(encoded), undefined, highest)
    ).rejects.toMatchObject({ code: 'PHOTOWALL_TOO_MANY' })
    const load = vi.spyOn(images, 'findForWall')
    const metadata = vi.spyOn(images, 'metadataForWall')
    for (const options of [
      { afterId: -1 },
      { afterId: 0.5 },
      { afterId: Number.MAX_SAFE_INTEGER + 1 },
      { pageSize: 11 }
    ])
      await expect(
        service.listPhotoPage(userId, options, undefined, highest)
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(load).not.toHaveBeenCalled()
    expect(metadata).not.toHaveBeenCalled()
    await service.addPhotos(userId, [encoded], undefined, highest)
    expect(await service.listPhotoPage(otherId, {}, undefined, highest)).toEqual({
      items: [],
      total: 0,
      nextCursor: null
    })
    expect(load).not.toHaveBeenCalled()
    expect(
      await service.listPhotoPage(userId, { afterId: Number.MAX_SAFE_INTEGER }, undefined, highest)
    ).toEqual({ items: [], total: 1, nextCursor: null })
    await service.clearPhotos(userId)
    const tiny = await sharp({
      create: { width: 1, height: 1, channels: 3, background: '#ffffff' }
    })
      .png()
      .toBuffer()
    try {
      const value = `data:image/png;base64,${tiny.toString('base64')}`
      expect(await service.addPhotos(userId, Array(200).fill(value), undefined, highest)).toEqual({
        added: 200,
        photoCount: 200
      })
      await expect(service.addPhotos(userId, [value], undefined, highest)).rejects.toMatchObject({
        code: 'PHOTOWALL_TOO_MANY'
      })
      expect(await images.countForWall(wallId)).toBe(200)
    } finally {
      tiny.fill(0)
    }
  })
})
