import 'reflect-metadata'
import { mkdtemp, readFile, readdir, rm, writeFile, rename, unlink } from 'node:fs/promises'
import { unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sequelize } from 'sequelize-typescript'
import * as yazl from 'yazl'
import * as yauzl from 'yauzl'
import ts from 'typescript'

vi.mock('../../../src/main/logger', () => ({ default: { error: vi.fn() } }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, unlinkSync: vi.fn(actual.unlinkSync) }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink) }
})
vi.mock('../../../src/main/services/image-validation', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/main/services/image-validation')>()
  return {
    ...actual,
    createImageValidationBudget: vi.fn(actual.createImageValidationBudget),
    validateImageDataUrl: vi.fn(actual.validateImageDataUrl)
  }
})
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
import PhotoWallRepository from '../../../src/main/database/repositories/PhotoWallRepository'
import PhotoWallImageRepository from '../../../src/main/database/repositories/PhotoWallImageRepository'
import PhotoWallService from '../../../src/main/services/PhotoWallService'
import DiaryBackupService from '../../../src/main/services/DiaryBackupService'
import * as imageValidation from '../../../src/main/services/image-validation'
import {
  PHOTOWALL_IMAGE_MAX_BYTES,
  PHOTOWALL_PORTRAIT_MAX_BYTES,
  PHOTOWALL_TOTAL_MAX_BYTES
} from '../../../src/common/photowall'

const testTemporaryRoot = fileURLToPath(
  new URL('../../../outputs/security-test-tmp/', import.meta.url)
)
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC'
const image = `data:image/png;base64,${png}`
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

async function zipContents(path: string): Promise<Map<string, Buffer>> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (error, value) =>
      error || !value ? reject(error) : resolve(value)
    )
  })
  const result = new Map<string, Buffer>()
  await new Promise<void>((resolve, reject) => {
    zip.on('error', reject)
    zip.on('end', resolve)
    zip.on('entry', (entry: yauzl.Entry) => {
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          reject(error)
          return
        }
        const chunks: Buffer[] = []
        stream.on('error', reject)
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
        stream.on('end', () => {
          result.set(entry.fileName, Buffer.concat(chunks))
          zip.readEntry()
        })
      })
    })
    zip.readEntry()
  })
  return result
}

describe('照片墙安全边界', () => {
  let database: Sequelize
  let userId: number
  let wallId: number
  let walls: PhotoWallRepository
  let images: PhotoWallImageRepository
  let service: PhotoWallService

  beforeAll(async () => {
    database = new Sequelize({ dialect: 'sqlite', storage: ':memory:', models, logging: false })
    await database.sync({ force: true })
    userId = (
      await new UserRepository().create({
        name: 'Owner',
        email: 'wall-security@example.com',
        password: 'owner-pass'
      })
    ).id
    wallId = (await new PhotoWallRepository().create({ userId })).id
  })
  beforeEach(async () => {
    await PhotoWallImage.destroy({ where: { photoWallId: wallId }, force: true })
    walls = new PhotoWallRepository()
    images = new PhotoWallImageRepository()
    service = new PhotoWallService(walls, images)
  })
  afterAll(async () => {
    await database.close()
  })

  it('拒绝文本伪装的图片与非规范 base64', async () => {
    for (const value of [
      'data:image/jpeg;base64,QUJD',
      `${image}\n`,
      'data:image/png;base64,A==='
    ]) {
      await expect(service.addPhotos(userId, [value])).rejects.toMatchObject({
        code: 'INVALID_INPUT'
      })
    }
    expect(await images.countForWall(wallId)).toBe(0)
  })

  it('并发 199 加两个单张上传时，在取得写事务后重新计数', async () => {
    await PhotoWallImage.bulkCreate(
      Array.from({ length: 199 }, () => ({
        photoWallId: wallId,
        type: 'photo' as const,
        dataUrl: image
      }))
    )
    // 内存 SQLite 只有一条连接；此队列模拟 IMMEDIATE 写锁的排队顺序。
    const original = walls.transaction.bind(walls)
    let queue = Promise.resolve()
    vi.spyOn(walls, 'transaction').mockImplementation((operation, options) => {
      const result = queue.then(() => original(operation, options))
      queue = result.then(
        () => undefined,
        () => undefined
      )
      return result
    })
    const results = await Promise.allSettled([
      service.addPhotos(userId, [image]),
      service.addPhotos(userId, [image])
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((result) => result.status === 'fulfilled')).toMatchObject({
      value: { added: 1, photoCount: 200 }
    })
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'PHOTOWALL_TOO_MANY' }
    })
    expect(await images.countForWall(wallId, 'photo')).toBe(200)
  })

  it('单批超过 25 MiB 时在解码前拒绝，不创建任何记录', async () => {
    const large = `data:image/png;base64,${'A'.repeat(Math.ceil(PHOTOWALL_IMAGE_MAX_BYTES / 3) * 4)}`
    await expect(service.addPhotos(userId, Array(6).fill(large))).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    })
    expect(await images.countForWall(wallId)).toBe(0)
  })

  it('旧超限墙先通过 SQL 长度聚合拒绝，不读取大 TEXT 或元数据列表', async () => {
    vi.spyOn(images, 'measureForWall').mockResolvedValue({
      count: 20,
      characters: PHOTOWALL_TOTAL_MAX_BYTES * 2,
      maxLength: 100
    })
    const metadata = vi.spyOn(images, 'metadataForWall')
    const data = vi.spyOn(images, 'findForWall')
    await expect(service.listPhotos(userId)).rejects.toMatchObject({
      code: 'PHOTOWALL_CAPACITY_EXCEEDED'
    })
    expect(metadata).not.toHaveBeenCalled()
    expect(data).not.toHaveBeenCalled()
  })

  it('新增照片不能跨过 64 MiB 墙总预算', async () => {
    vi.spyOn(images, 'measureForWall').mockResolvedValue({ count: 13, characters: 1, maxLength: 1 })
    vi.spyOn(images, 'metadataForWall').mockResolvedValue(
      Array.from({ length: 13 }, (_, index) => {
        const bytes =
          index === 12
            ? PHOTOWALL_TOTAL_MAX_BYTES - 12 * PHOTOWALL_IMAGE_MAX_BYTES
            : PHOTOWALL_IMAGE_MAX_BYTES
        const padding = (3 - (bytes % 3)) % 3
        return {
          id: index + 1,
          type: 'photo',
          prefix: 'data:image/png;base64,',
          suffix: padding === 2 ? '==' : padding === 1 ? 'A=' : 'AA',
          length: 22 + Math.ceil(bytes / 3) * 4
        }
      })
    )
    // PNG 头部是 22 个字符。
    await expect(service.addPhotos(userId, [image])).rejects.toMatchObject({
      code: 'PHOTOWALL_CAPACITY_EXCEEDED'
    })
    expect(await images.countForWall(wallId)).toBe(0)
  })

  it('人物替换在总预算边界不重复计算旧人物字节，也不加载旧 TEXT', async () => {
    await service.setPortrait(userId, image)
    const load = vi.spyOn(images, 'findForWall')
    vi.spyOn(images, 'measureForWall').mockResolvedValue({ count: 13, characters: 1, maxLength: 1 })
    const metadata = vi.spyOn(images, 'metadataForWall').mockResolvedValue(
      Array.from({ length: 13 }, (_, index) => {
        const bytes =
          index === 12
            ? PHOTOWALL_TOTAL_MAX_BYTES -
              12 * PHOTOWALL_IMAGE_MAX_BYTES -
              Buffer.from(png, 'base64').length
            : PHOTOWALL_IMAGE_MAX_BYTES
        const padding = (3 - (bytes % 3)) % 3
        return {
          id: index + 100,
          type: 'photo',
          prefix: 'data:image/png;base64,',
          suffix: padding === 2 ? '==' : padding === 1 ? 'A=' : 'AA',
          length: 22 + Math.ceil(bytes / 3) * 4
        }
      })
    )
    await service.setPortrait(userId, image)
    expect(metadata.mock.calls[0][1]).toBe('photo')
    expect(load).not.toHaveBeenCalled()
    expect(await images.countForWall(wallId, 'portrait')).toBe(1)
  })

  it('旧单张超过 10 MiB 硬上限照片在长度元数据阶段拒绝，不加载其 TEXT', async () => {
    const dataUrl = `data:image/png;base64,${'A'.repeat(16 * 1024 * 1024)}`
    await images.create({ photoWallId: wallId, type: 'photo', dataUrl })
    const load = vi.spyOn(images, 'findForWall')
    await expect(service.listPhotos(userId)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(load).not.toHaveBeenCalled()
  })

  it('SQLite NUL 后的存储字节计入聚合，在读取元数据和 TEXT 之前拒绝超限行', async () => {
    const dataUrl = `${image}\0${'A'.repeat(Math.ceil(PHOTOWALL_PORTRAIT_MAX_BYTES / 3) * 4 + 64)}`
    await images.create({ photoWallId: wallId, type: 'photo', dataUrl })
    expect(await images.measureForWall(wallId)).toEqual({
      count: 1,
      characters: Buffer.byteLength(dataUrl),
      maxLength: Buffer.byteLength(dataUrl)
    })
    const metadata = vi.spyOn(images, 'metadataForWall')
    const load = vi.spyOn(images, 'findForWall')
    for (const operation of [
      () => service.getState(userId),
      () => service.listPhotos(userId),
      () => service.addPhotos(userId, [image])
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
    expect(metadata).not.toHaveBeenCalled()
    expect(load).not.toHaveBeenCalled()
    // 超限墙仍允许明确清空，不必先加载图片。
    expect(await service.clearPhotos(userId)).toBe(0)
    expect(await service.listPhotos(userId)).toEqual([])
  })

  it('行元数据长度统计包括 NUL 和多字节文本的完整存储字节', async () => {
    const dataUrl = `${image}\0尾部`
    const row = await images.create({ photoWallId: wallId, type: 'photo', dataUrl })
    const metadata = await images.metadataForWall(wallId)
    expect(metadata).toHaveLength(1)
    expect(metadata[0]).toMatchObject({ id: row.id, length: Buffer.byteLength(dataUrl) })
    expect((await images.measureForWall(wallId, 'photo')).characters).toBe(
      Buffer.byteLength(dataUrl)
    )
    expect(await images.measureForWall(wallId, 'portrait')).toEqual({
      count: 0,
      characters: 0,
      maxLength: 0
    })
  })

  it('写入后的失效 guard 回滚新增图片', async () => {
    let valid = true
    PhotoWallImage.addHook('afterCreate', 'invalidate-wall-session', () => {
      valid = false
    })
    try {
      await expect(
        service.addPhotos(userId, [image], () => {
          if (!valid) throw new Error('会话失效')
        })
      ).rejects.toThrow()
      expect(await images.countForWall(wallId)).toBe(0)
    } finally {
      PhotoWallImage.removeHook('afterCreate', 'invalidate-wall-session')
    }
  })

  it('人物替换后 guard 失效，删除旧人物与插入新人物一起回滚', async () => {
    await service.setPortrait(userId, image)
    const previous = (await images.findAllByType(wallId, 'portrait'))[0]
    let valid = true
    PhotoWallImage.addHook('afterCreate', 'invalidate-portrait-session', () => {
      valid = false
    })
    try {
      await expect(
        service.setPortrait(userId, image, () => {
          if (!valid) throw new Error('会话失效')
        })
      ).rejects.toThrow()
      const rows = await images.findAllByType(wallId, 'portrait')
      expect(rows).toHaveLength(1)
      expect(rows[0].id).toBe(previous.id)
    } finally {
      PhotoWallImage.removeHook('afterCreate', 'invalidate-portrait-session')
    }
  })

  it('配置更新 await 后 guard 失效时回滚配置', async () => {
    const previous = (await service.getState(userId)).minImages
    let valid = true
    const original = walls.update.bind(walls)
    vi.spyOn(walls, 'update').mockImplementationOnce(async (...args) => {
      const result = await original(...args)
      valid = false
      return result
    })
    await expect(
      service.setMinImages(userId, previous === 20 ? 21 : 20, () => {
        if (!valid) throw new Error('会话失效')
      })
    ).rejects.toThrow()
    expect((await service.getState(userId)).minImages).toBe(previous)
  })

  it('外层写事务提交前再次复核已注册的 guard', async () => {
    let valid = true
    await expect(
      walls.transaction(async () => {
        await service.addPhotos(userId, [image], () => {
          if (!valid) throw new Error('会话失效')
        })
        valid = false
      })
    ).rejects.toThrow()
    expect(await images.countForWall(wallId)).toBe(0)
  })

  it('每张图片按需加载，预览只额外读取一张，zip 字节保持真实图片', async () => {
    const directory = await mkdtemp(join(testTemporaryRoot, 'wall-lazy-'))
    try {
      await service.addPhotos(userId, [image, image])
      await service.setPortrait(userId, image)
      const load = vi.spyOn(images, 'findForWall')
      const all = vi.spyOn(images, 'findAllByType')
      const lazy = vi.spyOn(yazl.ZipFile.prototype, 'addReadStreamLazy')
      const path = join(directory, 'wall.zip')
      expect(await service.exportWallpaper(userId, path)).toEqual({ photoCount: 2 })
      expect(all).not.toHaveBeenCalled()
      expect(lazy).toHaveBeenCalledTimes(4)
      expect(load).toHaveBeenCalledTimes(4)
      const transaction = load.mock.calls[0][2]?.transaction
      expect(transaction).toBeDefined()
      expect(load.mock.calls.every((call) => call[2]?.transaction === transaction)).toBe(true)
      const contents = await zipContents(path)
      for (const name of [
        'images/photo_000.png',
        'images/photo_001.png',
        'images/portrait.png',
        'preview.png'
      ]) {
        expect(contents.get(name)?.equals(Buffer.from(png, 'base64'))).toBe(true)
      }
      expect(contents.get('index.html')?.toString()).not.toContain(png)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('第二张惰性读取时 guard 失效，中止导出并保留原目标', async () => {
    const directory = await mkdtemp(join(testTemporaryRoot, 'wall-guard-'))
    try {
      await service.addPhotos(userId, [image, image])
      const path = join(directory, 'wall.zip')
      await writeFile(path, '原有文件')
      let valid = true
      let reads = 0
      const original = images.findForWall.bind(images)
      const load = vi.spyOn(images, 'findForWall').mockImplementation(async (...args) => {
        const row = await original(...args)
        if (++reads === 2) valid = false
        return row
      })
      await expect(
        service.exportWallpaper(userId, path, () => {
          if (!valid) throw new Error('会话失效')
        })
      ).rejects.toThrow()
      expect(load).toHaveBeenCalledTimes(2)
      expect(await readFile(path, 'utf8')).toBe('原有文件')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('流发送期间 guard 失效时，源流错误传入 pipeline 而非挂起导出', async () => {
    const directory = await mkdtemp(join(testTemporaryRoot, 'wall-stream-guard-'))
    try {
      await service.addPhotos(userId, [image])
      const path = join(directory, 'wall.zip')
      await writeFile(path, '原有文件')
      let valid = true
      const original = Readable.from.bind(Readable)
      vi.spyOn(Readable, 'from').mockImplementation((iterable, options) => {
        const stream = original(iterable, options)
        stream.once('resume', () => {
          stream.once('data', () => {
            valid = false
          })
        })
        return stream
      })
      await expect(
        service.exportWallpaper(userId, path, () => {
          if (!valid) throw new Error('会话失效')
        })
      ).rejects.toThrow()
      expect(await readFile(path, 'utf8')).toBe('原有文件')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('非法旧图片导出失败，保留已有目标并清理临时 zip', async () => {
    const directory = await mkdtemp(join(testTemporaryRoot, 'wall-invalid-'))
    try {
      await images.create({
        photoWallId: wallId,
        type: 'photo',
        dataUrl: 'data:image/png;base64,QUJD'
      })
      const path = join(directory, 'wall.zip')
      await writeFile(path, '原有文件')
      await expect(service.exportWallpaper(userId, path)).rejects.toThrow()
      expect(await readFile(path, 'utf8')).toBe('原有文件')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([false, true])(
    '安装 ZIP 的 await 期间失效，撤销自己的文件并恢复旧目标（旧目标：%s）',
    async (existing) => {
      const directory = await mkdtemp(join(testTemporaryRoot, 'wall-install-guard-'))
      try {
        await service.addPhotos(userId, [image])
        const path = join(directory, 'wall.zip')
        if (existing) await writeFile(path, '原有文件')
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
        let valid = true
        vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
          await actual.rename(source, destination)
          valid = false
        })
        await expect(
          service.exportWallpaper(userId, path, () => {
            if (!valid) throw new Error('会话失效')
          })
        ).rejects.toThrow('会话失效')
        expect(await readdir(directory)).toEqual(existing ? ['wall.zip'] : [])
        if (existing) expect(await readFile(path, 'utf8')).toBe('原有文件')
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it('安装期间第三方替换目标时不删除其文件，并保留旧目标副本和报告撤销失败', async () => {
    const directory = await mkdtemp(join(testTemporaryRoot, 'wall-install-replaced-'))
    try {
      await service.addPhotos(userId, [image])
      const path = join(directory, 'wall.zip')
      await writeFile(path, '原有文件')
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      let valid = true
      vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
        await actual.rename(source, destination)
        const foreign = join(directory, 'foreign.zip')
        await writeFile(foreign, '第三方文件')
        await actual.rename(foreign, destination)
        valid = false
      })
      const error = await service
        .exportWallpaper(userId, path, () => {
          if (!valid) throw new Error('会话失效')
        })
        .catch((value) => value)
      expect(error).toBeInstanceOf(AggregateError)
      expect(error.errors[0].message).toBe('会话失效')
      expect(await readFile(path, 'utf8')).toBe('第三方文件')
      const retained = (await readdir(directory)).find((name) => name.endsWith('.previous'))
      expect(retained).toBeDefined()
      expect(await readFile(join(directory, retained!), 'utf8')).toBe('原有文件')
      expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('安装后的清理失败不会静默成功，且恢复原目标', async () => {
    const directory = await mkdtemp(join(testTemporaryRoot, 'wall-cleanup-failure-'))
    try {
      await service.addPhotos(userId, [image])
      const path = join(directory, 'wall.zip')
      await writeFile(path, '原有文件')
      vi.mocked(unlinkSync).mockImplementationOnce(() => {
        throw new Error('清理失败')
      })
      await expect(service.exportWallpaper(userId, path)).rejects.toThrow('清理失败')
      expect(await readFile(path, 'utf8')).toBe('原有文件')
      expect(await readdir(directory)).toEqual(['wall.zip'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('安装成功后的旧目标清理是同步的，最后守卫之后不再有异步撤销窗口', async () => {
    const directory = await mkdtemp(join(testTemporaryRoot, 'wall-final-cleanup-'))
    try {
      await service.addPhotos(userId, [image])
      const path = join(directory, 'wall.zip')
      await writeFile(path, '原有文件')
      const asyncCleanup = vi.mocked(unlink)
      const syncCleanup = vi.mocked(unlinkSync)
      asyncCleanup.mockClear()
      syncCleanup.mockClear()
      expect(await service.exportWallpaper(userId, path, vi.fn())).toEqual({ photoCount: 1 })
      expect(asyncCleanup).not.toHaveBeenCalled()
      expect(syncCleanup).toHaveBeenCalledTimes(1)
      expect(String(syncCleanup.mock.calls[0][0])).toMatch(/\.previous$/)
      expect(await readdir(directory)).toEqual(['wall.zip'])
      expect((await zipContents(path)).get('images/photo_000.png')).toEqual(
        Buffer.from(png, 'base64')
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('同一规范化目标的跨实例、跨导出类型操作互斥，完成后释放准入', async () => {
    const directory = await mkdtemp(join(testTemporaryRoot, 'wall-destination-lock-'))
    let release: (() => void) | undefined
    let notify: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      notify = resolve
    })
    const internal = service as unknown as {
      exportWallpaperInto(
        userId: number,
        path: string,
        guard?: () => void
      ): Promise<{ photoCount: number }>
    }
    const original = internal.exportWallpaperInto.bind(service)
    const privateExport = vi
      .spyOn(internal, 'exportWallpaperInto')
      .mockImplementationOnce(async (...args) => {
        notify()
        await gate
        return original(...args)
      })
    let first: Promise<{ photoCount: number }> | undefined
    const syntheticKey = Buffer.alloc(32, 7)
    try {
      await service.addPhotos(userId, [image])
      const path = join(directory, 'wall.zip')
      first = service.exportWallpaper(userId, path)
      void first.catch(() => undefined)
      await entered
      const alias = `${directory}/./wall.zip`
      await expect(
        new PhotoWallService(walls, images).exportWallpaper(userId, alias)
      ).rejects.toMatchObject({ code: 'IPC_BUSY' })
      await expect(
        new DiaryBackupService().exportBackup(userId, 1, undefined, syntheticKey, alias)
      ).rejects.toMatchObject({ code: 'IPC_BUSY' })
      expect(syntheticKey).toEqual(Buffer.alloc(32, 7))
      release?.()
      expect(await first).toEqual({ photoCount: 1 })
      privateExport.mockRejectedValueOnce(new Error('合成的导出失败'))
      await expect(service.exportWallpaper(userId, path)).rejects.toThrow('合成的导出失败')
      // A failed operation must also release the shared destination lock.
      expect(await service.exportWallpaper(userId, alias)).toEqual({ photoCount: 1 })
      expect(await readdir(directory)).toEqual(['wall.zip'])
    } finally {
      release?.()
      await first?.catch(() => undefined)
      syntheticKey.fill(0)
      privateExport.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('新增与读取共享 256M/30秒，导出共享有限 202×32M/300秒预算，预览不绕过预算', async () => {
    const directory = await mkdtemp(join(testTemporaryRoot, 'wall-decode-budget-'))
    try {
      const validate = vi.mocked(imageValidation.validateImageDataUrl)
      const createBudget = vi.mocked(imageValidation.createImageValidationBudget)
      const guard = vi.fn()
      const check = async (operation: () => Promise<unknown>, count: number, exporting = false) => {
        validate.mockClear()
        createBudget.mockClear()
        await operation()
        expect(createBudget).toHaveBeenCalledTimes(1)
        expect(createBudget).toHaveBeenCalledWith({
          maxPixels: exporting ? 202 * 32_000_000 : 256_000_000,
          timeoutMs: exporting ? 300_000 : 30_000,
          assertActive: guard
        })
        expect(validate).toHaveBeenCalledTimes(count)
        const budget = validate.mock.calls[0][2]
        expect(budget).toBeDefined()
        expect(validate.mock.calls.every((call) => call[2] === budget)).toBe(true)
      }
      await check(() => service.addPhotos(userId, [image, image], guard), 2)
      await check(() => service.listPhotos(userId, guard), 2)
      await service.setPortrait(userId, image, guard)
      await check(() => service.getState(userId, guard), 1)
      await check(
        () => service.exportWallpaper(userId, join(directory, 'wall.zip'), guard),
        4,
        true
      )
      const exportBudget = createBudget.mock.results[0].value
      expect(exportBudget.remainingMs()).toBeGreaterThan(0)
      expect(exportBudget.remainingMs()).toBeLessThanOrEqual(300_000)
      exportBudget.consumePixels(202 * 32_000_000 - 4)
      expect(() => exportBudget.consumePixels(1)).toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('小页使用 pageSize×32M/30秒预算，同一快照仅按页读取，源哈希不是预览哈希', async () => {
    await service.addPhotos(userId, [image, image, image])
    const load = vi.spyOn(images, 'findForWall')
    const validate = vi.mocked(imageValidation.validateImageDataUrl)
    const createBudget = vi.mocked(imageValidation.createImageValidationBudget)
    validate.mockClear()
    createBudget.mockClear()
    const guard = vi.fn()
    const page = await service.listPhotoPage(userId, { pageSize: 2 }, guard)
    expect(page.items).toHaveLength(2)
    expect(page.total).toBe(3)
    expect(page.nextCursor).toBe(page.items[1].id)
    expect(load).toHaveBeenCalledTimes(2)
    expect(createBudget).toHaveBeenCalledExactlyOnceWith({
      maxPixels: 64_000_000,
      timeoutMs: 30_000,
      assertActive: guard
    })
    const budget = validate.mock.calls[0][2]
    expect(validate.mock.calls.every((call) => call[2] === budget)).toBe(true)
    expect(
      validate.mock.calls.every(
        (call) => call[3]?.maxEdge === 640 && call[3]?.maxBytes === 128 * 1024
      )
    ).toBe(true)
    expect(
      load.mock.calls.every((call) => call[2]?.transaction === load.mock.calls[0][2]?.transaction)
    ).toBe(true)
    expect(page.items.every((value) => /^[a-f0-9]{64}$/.test(value.sourceHash!))).toBe(true)
  })

  it('分页校验后会话撤销不返回预览并清零源 Buffer', async () => {
    await service.addPhotos(userId, [image, image])
    const bytes = Buffer.from(png, 'base64')
    let active = true
    vi.mocked(imageValidation.validateImageDataUrl).mockImplementationOnce(async () => {
      active = false
      return {
        bytes,
        dataUrl: image,
        mimeType: 'image/png',
        width: 1,
        height: 1,
        frames: 1,
        previewDataUrl: image
      }
    })
    const load = vi.spyOn(images, 'findForWall')
    await expect(
      service.listPhotoPage(userId, {}, () => {
        if (!active) throw new Error('会话撤销')
      })
    ).rejects.toThrow('会话撤销')
    expect(bytes.every((byte) => byte === 0)).toBe(true)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('导出目标为目录时拒绝', async () => {
    const directory = await mkdtemp(join(testTemporaryRoot, 'wall-directory-'))
    try {
      await expect(service.exportWallpaper(userId, directory)).rejects.toMatchObject({
        code: 'INVALID_INPUT'
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

// 只执行照片墙组件自身的脚本，不启动 GUI，也不加载其他 renderer 文件。
async function photoWallController() {
  const source = await readFile(
    fileURLToPath(
      new URL('../../../src/renderer/src/views/photowall/PhotoWall.vue', import.meta.url)
    ),
    'utf8'
  )
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]
  const parsedScript = ts.createSourceFile(
    'photo-wall-component.ts',
    script,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS
  )
  const withoutImports = ts.factory.updateSourceFile(
    parsedScript,
    parsedScript.statements.filter((statement) => !ts.isImportDeclaration(statement))
  )
  const compiled = ts.transpileModule(ts.createPrinter().printFile(withoutImports), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText
  const text = {
    loadFail: '加载失败',
    clearFail: '清空失败',
    clearSuccess: '已清空',
    clearConfirm: '清空确认',
    clear: '清空',
    batchTooLarge: '批次超过 25 MiB',
    uploadFail: '上传失败',
    tooMany: '数量超限',
    singleImageTooLarge: '单图超过{size}MiB',
    capacityExceeded: '总容量超限'
  }
  const api = {
    getPhotoWall: vi.fn().mockResolvedValue({ success: false, message: '旧墙超限' }),
    listPhotoWallPhotos: vi.fn().mockResolvedValue({ success: false, message: '旧墙超限' }),
    getPhotoWallLimits: vi.fn().mockResolvedValue({
      success: true,
      data: { imageMaxBytes: 5 * 1024 * 1024, totalMaxBytes: 64 * 1024 * 1024, usedBytes: 0 }
    }),
    clearPhotoWall: vi.fn(),
    addPhotoWallPhotos: vi.fn()
  }
  const messages = { error: vi.fn(), success: vi.fn(), warning: vi.fn() }
  const confirm = vi.fn().mockResolvedValue('confirm')
  const compressPhoto = vi.fn().mockResolvedValue(image)
  const bindings = {
    ref: (value: unknown) => ({ value }),
    computed: (value: () => unknown) => ({
      get value() {
        return value()
      }
    }),
    useRouter: () => ({ push: vi.fn() }),
    // This extracted-script harness fixes one active session and tests resource budgets.
    // Real session changes and stale callbacks are covered by mounted renderer tests.
    useSessionOperation: () => ({
      capture: () => ({
        isActive: () => true,
        call: async <T>(request: () => Promise<T>): Promise<T> => request()
      })
    }),
    useI18nStore: () => ({ locale: 'zh', t: { photowall: text } }),
    onMounted: vi.fn(),
    window: { api },
    ElMessage: messages,
    ElMessageBox: { confirm },
    compressPhoto,
    readAsDataUrl: vi.fn(),
    loadPhotoWallPreview: () => api.listPhotoWallPhotos(),
    dataUrlBytes: (url: string) => {
      const body = url.slice(url.indexOf(',') + 1)
      return (body.length / 4) * 3 - (body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0)
    },
    hashImageDataUrl: async () => undefined,
    PhotoWallImageError: class extends Error {},
    PHOTOWALL_IMAGE_MAX_BYTES: 5 * 1024 * 1024,
    PHOTOWALL_IMAGE_HARD_MAX_BYTES: 10 * 1024 * 1024,
    PHOTOWALL_PORTRAIT_MAX_BYTES: 20 * 1024 * 1024,
    PHOTOWALL_TOTAL_MAX_BYTES: 64 * 1024 * 1024,
    PHOTOWALL_TOTAL_HARD_MAX_BYTES: 512 * 1024 * 1024,
    PHOTOWALL_BATCH_MAX_BYTES: 25 * 1024 * 1024,
    PHOTOWALL_MAX_IMAGES: 200
  }
  const controller = new Function(
    ...Object.keys(bindings),
    `${compiled}\nreturn { load, onPhotosChange, clearPhotos, photos, state, loadFailed, clearing, enough, usage, limitsLoaded }`
  )(...Object.values(bindings))
  controller.limitsLoaded.value = true
  return { controller, api, messages, confirm, compressPhoto, source }
}

describe('照片墙前端安全恢复与批次预算', () => {
  it('旧墙两项加载均失败时仍显示明确恢复入口和清空按钮，不允许预览', async () => {
    const { controller, source } = await photoWallController()
    await controller.load()
    expect(controller.loadFailed.value).toBe(true)
    expect(controller.photos.value).toEqual([])
    expect(controller.enough.value).toBe(false)
    expect(source).toContain('v-if="photos.length || state.photoCount > 0 || loadFailed"')
    expect(source).toContain('v-if="loadFailed && !loading"')
    expect(source).toContain('{{ t.recoveryHint }}')
    expect(source).toContain('v-if="state.portrait || loadFailed"')
  })

  it('照片列表失败不被当作空墙成功加载', async () => {
    const { controller, api } = await photoWallController()
    api.getPhotoWall.mockResolvedValueOnce({
      success: true,
      data: { minImages: 10, photoCount: 200, portrait: null, rounded: false }
    })
    await controller.load()
    expect(controller.state.value.photoCount).toBe(200)
    expect(controller.loadFailed.value).toBe(true)
    expect(controller.enough.value).toBe(false)
  })

  it('拒绝清空确认时不发删除请求，失败响应及异常不伪成功', async () => {
    const { controller, api, confirm, messages } = await photoWallController()
    controller.photos.value = [{ id: 1, dataUrl: image }]
    controller.state.value.photoCount = 1
    confirm.mockRejectedValueOnce('cancel')
    await controller.clearPhotos()
    expect(api.clearPhotoWall).not.toHaveBeenCalled()
    for (const failure of [
      () => api.clearPhotoWall.mockResolvedValueOnce({ success: false }),
      () => api.clearPhotoWall.mockResolvedValueOnce({ success: true }),
      () => api.clearPhotoWall.mockRejectedValueOnce(new Error('IPC 失败'))
    ]) {
      failure()
      await controller.clearPhotos()
      expect(controller.photos.value).toHaveLength(1)
      expect(controller.state.value.photoCount).toBe(1)
      expect(controller.clearing.value).toBe(false)
    }
    expect(messages.success).not.toHaveBeenCalled()
    expect(messages.error).toHaveBeenCalledTimes(3)
  })

  it('清空只有明确成功和 0 计数时更新状态，并再次加载验证恢复', async () => {
    const { controller, api, messages } = await photoWallController()
    api.clearPhotoWall.mockResolvedValueOnce({ success: true, data: 0 })
    api.getPhotoWall.mockResolvedValueOnce({
      success: true,
      data: { minImages: 10, photoCount: 0, portrait: null, rounded: false }
    })
    api.listPhotoWallPhotos.mockResolvedValueOnce({ success: true, data: [] })
    controller.loadFailed.value = true
    await controller.clearPhotos()
    expect(controller.photos.value).toEqual([])
    expect(controller.loadFailed.value).toBe(false)
    expect(api.getPhotoWall).toHaveBeenCalledTimes(1)
    expect(messages.success).toHaveBeenCalledTimes(1)
  })

  it('所选原文件总大小超过 25 MiB 时，在任何读取或压缩前整批拒绝', async () => {
    const { controller, api, compressPhoto, messages, source } = await photoWallController()
    const input = { files: [{ size: 13 * 1024 * 1024 }, { size: 13 * 1024 * 1024 }], value: '选中' }
    await controller.onPhotosChange({ target: input })
    expect(input.value).toBe('')
    expect(compressPhoto).not.toHaveBeenCalled()
    expect(api.addPhotoWallPhotos).not.toHaveBeenCalled()
    expect(messages.error).toHaveBeenCalledWith('批次超过 25 MiB')
    expect(source).toContain('{{ t.batchLimitHint }}')
  })

  it('处理后总大小超限也不提交部分照片', async () => {
    const { controller, api, compressPhoto, messages } = await photoWallController()
    controller.usage.value.imageMaxBytes = 10 * 1024 * 1024
    compressPhoto.mockResolvedValue(`data:image/png;base64,${'A'.repeat(12 * 1024 * 1024)}`)
    await controller.onPhotosChange({
      target: { files: [{ size: 1 }, { size: 1 }, { size: 1 }], value: '' }
    })
    expect(compressPhoto).toHaveBeenCalledTimes(3)
    expect(api.addPhotoWallPhotos).not.toHaveBeenCalled()
    expect(messages.success).not.toHaveBeenCalled()
    expect(messages.error).toHaveBeenCalledWith('批次超过 25 MiB')
  })
})
