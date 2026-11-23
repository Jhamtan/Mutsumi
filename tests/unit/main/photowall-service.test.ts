import 'reflect-metadata'
import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Sequelize } from 'sequelize-typescript'
import * as yauzl from 'yauzl'

vi.mock('../../../src/main/logger', () => ({ default: { error: vi.fn() } }))
import { User } from '../../../src/main/database/models/user.model'
import { Notebook } from '../../../src/main/database/models/notebook.model'
import { Diary } from '../../../src/main/database/models/diary.model'
import { DiaryImage } from '../../../src/main/database/models/diary-image.model'
import { Itinerary } from '../../../src/main/database/models/itinerary.model'
import { ItineraryPlace } from '../../../src/main/database/models/itinerary-place.model'
import { ItineraryLeg } from '../../../src/main/database/models/itinerary-leg.model'
import { PhotoWall } from '../../../src/main/database/models/photowall.model'
import { PhotoWallImage } from '../../../src/main/database/models/photowall-image.model'
import UserRepository from '../../../src/main/database/repositories/UserRepository'
import PhotoWallService from '../../../src/main/services/PhotoWallService'

/**
 * Integration test for PhotoWallService on in-memory SQLite: per-user config,
 * photo uploads, portrait lifecycle, minimum-count setting and validation.
 */
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

function createDatabase(): Sequelize {
  return new Sequelize({ dialect: 'sqlite', storage: ':memory:', models, logging: false })
}

const testTemporaryRoot = fileURLToPath(
  new URL('../../../outputs/security-test-tmp/', import.meta.url)
)

function dataUrl(index: number): string {
  const png =
    index % 2
      ? 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC'
      : 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgYPgPAAEDAQBdlO9aAAAAAElFTkSuQmCC'
  return `data:image/png;base64,${png}`
}

async function readZipEntryNames(zipPath: string): Promise<string[]> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, value) => {
      if (error || !value) reject(error ?? new Error('Unable to open zip'))
      else resolve(value)
    })
  })
  const names: string[] = []
  await new Promise<void>((resolve, reject) => {
    zip.on('error', reject)
    zip.on('end', resolve)
    zip.on('entry', (entry: yauzl.Entry) => {
      names.push(entry.fileName)
      zip.readEntry()
    })
    zip.readEntry()
  })
  return names
}

describe('PhotoWallService', () => {
  let database: Sequelize
  let userId: number
  let otherUserId: number
  let service: PhotoWallService

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
    service = new PhotoWallService()
  })

  afterAll(async () => {
    await database?.close()
  })

  it('starts with default configuration and no photos', async () => {
    const state = await service.getState(userId)
    expect(state).toEqual({
      minImages: 10,
      photoCount: 0,
      portrait: null,
      rounded: false
    })
  })

  it('adds photos and reflects the new count', async () => {
    const result = await service.addPhotos(userId, [dataUrl(1), dataUrl(2), dataUrl(3)])
    expect(result).toEqual({ added: 3, photoCount: 3 })
    expect((await service.getState(userId)).photoCount).toBe(3)
  })

  it('lists photos with stable ids and data URLs', async () => {
    const photos = await service.listPhotos(userId)
    expect(photos).toHaveLength(3)
    expect(photos.map((p) => p.dataUrl)).toEqual([dataUrl(1), dataUrl(2), dataUrl(3)])
    expect(photos[0].id).toBeGreaterThan(0)
  })

  it('sets and clears the portrait image', async () => {
    const portrait = dataUrl(99)
    expect(await service.setPortrait(userId, portrait)).toBe(portrait)
    expect((await service.getState(userId)).portrait).toBe(portrait)

    // 替换人物图片，仍只有一张
    const replaced = dataUrl(100)
    await service.setPortrait(userId, replaced)
    expect((await service.getState(userId)).portrait).toBe(replaced)

    expect(await service.setPortrait(userId, null)).toBeNull()
    expect((await service.getState(userId)).portrait).toBeNull()
  })

  it('updates the minimum photo count', async () => {
    expect(await service.setMinImages(userId, 20)).toBe(20)
    expect((await service.getState(userId)).minImages).toBe(20)
  })

  it('updates the rounded setting', async () => {
    expect(await service.setRounded(userId, true)).toBe(true)
    expect((await service.getState(userId)).rounded).toBe(true)

    expect(await service.setRounded(userId, false)).toBe(false)
    expect((await service.getState(userId)).rounded).toBe(false)
  })

  it('deletes a single photo', async () => {
    await service.clearPhotos(userId)
    await service.addPhotos(userId, [dataUrl(1), dataUrl(2)])
    const [first] = await service.listPhotos(userId)
    const count = await service.deletePhoto(userId, first.id)
    expect(count).toBe(1)
    expect((await service.listPhotos(userId)).map((p) => p.dataUrl)).toEqual([dataUrl(2)])
  })

  it('clears all photos but keeps the portrait and config', async () => {
    await service.setPortrait(userId, dataUrl(50))
    await service.clearPhotos(userId)
    const state = await service.getState(userId)
    expect(state.photoCount).toBe(0)
    expect(state.portrait).toBe(dataUrl(50))
    expect(state.minImages).toBe(20)
  })

  it('isolates each user’s wall', async () => {
    await service.addPhotos(userId, [dataUrl(1)])
    expect((await service.getState(otherUserId)).photoCount).toBe(0)
    expect(await service.listPhotos(otherUserId)).toEqual([])
  })

  it('rejects malformed input', async () => {
    await expect(service.addPhotos(userId, ['not-a-data-url'])).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    })
    await expect(service.setMinImages(userId, 1)).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    })
    await expect(service.setPortrait(userId, 'data:text/plain;base64,AAAA')).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    })
  })

  it('rejects batches that would exceed the photo limit', async () => {
    await expect(service.addPhotos(userId, Array(201).fill(dataUrl(1)))).rejects.toMatchObject({
      code: 'PHOTOWALL_TOO_MANY'
    })
  })

  it('exports a Wallpaper Engine web wallpaper package', async () => {
    const workDir = await mkdtemp(join(testTemporaryRoot, 'myapp-photowall-export-'))
    const zipPath = join(workDir, 'wallpaper.zip')
    try {
      await service.clearPhotos(userId)
      await service.addPhotos(userId, [dataUrl(1), dataUrl(2)])
      await service.setPortrait(userId, dataUrl(99))

      const result = await service.exportWallpaper(userId, zipPath)
      expect(result.photoCount).toBe(2)

      const names = await readZipEntryNames(zipPath)
      expect(names).toContain('index.html')
      expect(names).toContain('style.css')
      expect(names).toContain('wallpaper.js')
      // project.json 由 Wallpaper Engine 导入时自动生成，不包含在压缩包中
      expect(names).not.toContain('project.json')
      expect(names).toContain('images/photo_000.png')
      expect(names).toContain('images/photo_001.png')
      expect(names).toContain('images/portrait.png')
      expect(names).toContain('preview.png')
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  })
})
