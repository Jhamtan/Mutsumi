/** Photo wall service: in-transaction quota checks, consistent reads and per-image streaming export. */
import { lstatSync, unlinkSync, type Stats } from 'node:fs'
import { lstat, stat, realpath, open, link, unlink, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Transaction } from 'sequelize'
import * as yazl from 'yazl'
import type {
  AddPhotosResultDTO,
  PhotoWallLimitsDTO,
  PhotoWallPhotoDTO,
  PhotoWallPhotoPageDTO,
  PhotoWallPhotoPageOptionsDTO,
  PhotoWallStateDTO
} from '@common/photowall'
import {
  PHOTOWALL_IMAGE_MAX_BYTES,
  PHOTOWALL_IMAGE_HARD_MAX_BYTES,
  PHOTOWALL_TOTAL_HARD_MAX_BYTES,
  PHOTOWALL_PREVIEW_MAX_EDGE,
  PHOTOWALL_PREVIEW_MAX_BYTES,
  PHOTOWALL_MAX_IMAGES,
  PHOTOWALL_MIN_IMAGES_MAX,
  PHOTOWALL_MIN_IMAGES_MIN,
  PHOTOWALL_PORTRAIT_MAX_BYTES,
  PHOTOWALL_BATCH_MAX_BYTES,
  PHOTOWALL_TOTAL_MAX_BYTES
} from '@common/photowall'
import { AppError } from '../errors'
import { PhotoWallLimitsSchema, PhotoWallPhotoPageSchema } from '../ipc/schemas'
import { PhotoWall } from '../database/models/photowall.model'
import PhotoWallRepository from '../database/repositories/PhotoWallRepository'
import PhotoWallImageRepository, {
  type PhotoWallImageMetadata
} from '../database/repositories/PhotoWallImageRepository'
import { registerTransactionGuard, withReadSnapshot } from '../database/transaction'
import { createImageValidationBudget, validateImageDataUrl } from './image-validation'
import { buildIndexHtml, buildStyleCss, buildWallpaperJs } from './photo-wall-export'
import { withExportDestination } from './export-destination'

const DEFAULT_LIMITS: PhotoWallLimitsDTO = {
  imageMaxBytes: PHOTOWALL_IMAGE_MAX_BYTES,
  totalMaxBytes: PHOTOWALL_TOTAL_MAX_BYTES
}

type Guard = (() => void) | undefined
type ImageValidationBudget = ReturnType<typeof createImageValidationBudget>
interface ImageMetadata extends PhotoWallImageMetadata {
  bytes: number
  extension: string
}

export class PhotoWallService {
  constructor(
    private readonly walls = new PhotoWallRepository(),
    private readonly images = new PhotoWallImageRepository()
  ) {}

  async getState(
    userId: number,
    guard?: () => void,
    limits: PhotoWallLimitsDTO = DEFAULT_LIMITS
  ): Promise<PhotoWallStateDTO> {
    limits = this.checkedLimits(limits)
    const budget = this.imageBudget(guard)
    return this.read(
      userId,
      async (wall, transaction) => {
        const metadata = await this.checkedMetadata(wall.id, transaction, guard, undefined, limits)
        guard?.()
        const portraitMeta = metadata.find((image) => image.type === 'portrait')
        let portrait: string | null = null
        if (portraitMeta) {
          const image = await this.images.findForWall(wall.id, portraitMeta.id, { transaction })
          guard?.()
          if (!image) throw new AppError('Image not found.', 'INVALID_INPUT')
          portrait = (
            await this.validateImage(image.dataUrl, PHOTOWALL_PORTRAIT_MAX_BYTES, guard, budget)
          ).dataUrl
          guard?.()
        }
        return {
          minImages: wall.minImages,
          photoCount: metadata.filter((image) => image.type === 'photo').length,
          portrait,
          rounded: wall.rounded
        }
      },
      guard
    )
  }

  async getUsage(userId: number, guard?: () => void): Promise<number> {
    return this.read(
      userId,
      async (wall, transaction) => {
        const metadata = await this.checkedMetadata(wall.id, transaction, guard, undefined, {
          imageMaxBytes: PHOTOWALL_IMAGE_HARD_MAX_BYTES,
          totalMaxBytes: PHOTOWALL_TOTAL_HARD_MAX_BYTES
        })
        return metadata.reduce((sum, image) => sum + image.bytes, 0)
      },
      guard
    )
  }

  async listPhotoPage(
    userId: number,
    options: PhotoWallPhotoPageOptionsDTO = {},
    guard?: () => void,
    limits: PhotoWallLimitsDTO = DEFAULT_LIMITS
  ): Promise<PhotoWallPhotoPageDTO> {
    guard?.()
    limits = this.checkedLimits(limits)
    const parsed = PhotoWallPhotoPageSchema.safeParse(options)
    if (!parsed.success) throw new AppError('Invalid photo page.', 'INVALID_INPUT')
    const { afterId, pageSize } = parsed.data
    const budget = this.imageBudget(guard, pageSize * 32_000_000)
    return this.read(
      userId,
      async (wall, transaction) => {
        const metadata = await this.checkedMetadata(wall.id, transaction, guard, undefined, limits)
        const photos = metadata
          .filter((image) => image.type === 'photo')
          .sort((a, b) => a.id - b.id)
        const remaining = photos.filter((image) => image.id > afterId)
        const page = remaining.slice(0, pageSize)
        const items: PhotoWallPhotoDTO[] = []
        for (const meta of page) {
          const row = await this.images.findForWall(wall.id, meta.id, { transaction })
          guard?.()
          if (!row || row.type !== 'photo') throw new AppError('Image changed.', 'INVALID_INPUT')
          const image = await validateImageDataUrl(
            row.dataUrl,
            PHOTOWALL_IMAGE_HARD_MAX_BYTES,
            budget,
            {
              maxEdge: PHOTOWALL_PREVIEW_MAX_EDGE,
              maxBytes: PHOTOWALL_PREVIEW_MAX_BYTES
            }
          )
          try {
            guard?.()
            if (image.bytes.length !== meta.bytes || !image.previewDataUrl)
              throw new AppError('Invalid photo preview.', 'INVALID_INPUT')
            items.push({
              id: row.id,
              dataUrl: image.previewDataUrl,
              sourceHash: createHash('sha256').update(image.bytes).digest('hex')
            })
          } finally {
            image.bytes.fill(0)
          }
          guard?.()
        }
        return {
          items,
          total: photos.length,
          nextCursor: remaining.length > page.length ? page[page.length - 1].id : null
        }
      },
      guard
    )
  }

  async listPhotos(userId: number, guard?: () => void): Promise<PhotoWallPhotoDTO[]> {
    // The legacy endpoint allows at most a 64 MiB original-image aggregate; large walls must use paginated thumbnails.
    const limits = DEFAULT_LIMITS
    const budget = this.imageBudget(guard)
    return this.read(
      userId,
      async (wall, transaction) => {
        const metadata = await this.checkedMetadata(wall.id, transaction, guard, undefined, limits)
        guard?.()
        const result: PhotoWallPhotoDTO[] = []
        for (const meta of metadata.filter((image) => image.type === 'photo')) {
          const image = await this.images.findForWall(wall.id, meta.id, { transaction })
          guard?.()
          if (!image) throw new AppError('Image not found.', 'INVALID_INPUT')
          const validated = await this.validateImage(
            image.dataUrl,
            PHOTOWALL_IMAGE_HARD_MAX_BYTES,
            guard,
            budget
          )
          guard?.()
          result.push({ id: image.id, dataUrl: validated.dataUrl })
        }
        return result
      },
      guard
    )
  }

  async setMinImages(userId: number, minImages: number, guard?: () => void): Promise<number> {
    guard?.()
    const value = Math.floor(minImages)
    if (
      !Number.isSafeInteger(value) ||
      value < PHOTOWALL_MIN_IMAGES_MIN ||
      value > PHOTOWALL_MIN_IMAGES_MAX
    ) {
      throw new AppError('Invalid minimum image count.', 'INVALID_INPUT')
    }
    return this.write(
      userId,
      async (wall, transaction) => {
        await this.walls.update(wall.id, { minImages: value }, { transaction })
        guard?.()
        return value
      },
      guard
    )
  }

  async setRounded(userId: number, rounded: boolean, guard?: () => void): Promise<boolean> {
    guard?.()
    if (typeof rounded !== 'boolean')
      throw new AppError('Invalid rounded setting.', 'INVALID_INPUT')
    return this.write(
      userId,
      async (wall, transaction) => {
        await this.walls.update(wall.id, { rounded }, { transaction })
        guard?.()
        return rounded
      },
      guard
    )
  }

  async addPhotos(
    userId: number,
    dataUrls: string[],
    guard?: () => void,
    limits: PhotoWallLimitsDTO = DEFAULT_LIMITS
  ): Promise<AddPhotosResultDTO> {
    guard?.()
    limits = this.checkedLimits(limits)
    if (!Array.isArray(dataUrls)) throw new AppError('Invalid photos.', 'INVALID_INPUT')
    if (dataUrls.length > PHOTOWALL_MAX_IMAGES)
      throw new AppError('Too many photos.', 'PHOTOWALL_TOO_MANY')
    // Bound the batch string length before decoding, so huge input never reaches the decoder first.
    const encodedLimit = Math.ceil(PHOTOWALL_BATCH_MAX_BYTES / 3) * 4 + dataUrls.length * 32
    let characters = 0
    for (const value of dataUrls) {
      if (typeof value !== 'string') throw new AppError('Invalid photo.', 'INVALID_INPUT')
      characters += value.length
      if (characters > encodedLimit)
        throw new AppError('Photo batch is too large.', 'INVALID_INPUT')
    }
    const budget = this.imageBudget(guard)
    const batchBytes = dataUrls.reduce(
      (sum, value) => sum + this.inputBytes(value, limits.imageMaxBytes),
      0
    )
    if (batchBytes > PHOTOWALL_BATCH_MAX_BYTES)
      throw new AppError('Photo batch is too large.', 'INVALID_INPUT')
    return this.write(
      userId,
      async (wall, transaction) => {
        const metadata = await this.checkedMetadata(wall.id, transaction, guard, undefined, limits)
        guard?.()
        const existing = metadata.filter((image) => image.type === 'photo').length
        if (existing + dataUrls.length > PHOTOWALL_MAX_IMAGES)
          throw new AppError('Too many photos.', 'PHOTOWALL_TOO_MANY')
        if (
          metadata.reduce((sum, image) => sum + image.bytes, 0) + batchBytes >
          limits.totalMaxBytes
        ) {
          throw new AppError('Photo wall is too large.', 'PHOTOWALL_CAPACITY_EXCEEDED')
        }
        for (const dataUrl of dataUrls) {
          const image = await this.validateImage(dataUrl, limits.imageMaxBytes, guard, budget)
          guard?.()
          await this.images.create(
            { photoWallId: wall.id, type: 'photo', dataUrl: image.dataUrl },
            { transaction }
          )
          guard?.()
        }
        const photoCount = await this.images.countForWall(wall.id, 'photo', { transaction })
        guard?.()
        return { added: dataUrls.length, photoCount }
      },
      guard
    )
  }

  async setPortrait(
    userId: number,
    dataUrl: string | null,
    guard?: () => void,
    limits: PhotoWallLimitsDTO = DEFAULT_LIMITS
  ): Promise<string | null> {
    guard?.()
    limits = this.checkedLimits(limits)
    const bytes = dataUrl === null ? 0 : this.inputBytes(dataUrl, PHOTOWALL_PORTRAIT_MAX_BYTES)
    return this.write(
      userId,
      async (wall, transaction) => {
        if (dataUrl !== null) {
          // The portrait being replaced does not count toward the new quota, and no old TEXT needs loading.
          const metadata = await this.checkedMetadata(wall.id, transaction, guard, 'photo', limits)
          guard?.()
          if (
            metadata.reduce((sum, image) => sum + image.bytes, 0) + bytes >
            limits.totalMaxBytes
          ) {
            throw new AppError('Photo wall is too large.', 'PHOTOWALL_CAPACITY_EXCEEDED')
          }
        }
        const validated =
          dataUrl === null
            ? null
            : await this.validateImage(dataUrl, PHOTOWALL_PORTRAIT_MAX_BYTES, guard)
        guard?.()
        await this.images.deleteForWall(wall.id, 'portrait', undefined, { transaction })
        guard?.()
        if (validated) {
          await this.images.create(
            { photoWallId: wall.id, type: 'portrait', dataUrl: validated.dataUrl },
            { transaction }
          )
          guard?.()
        }
        return validated?.dataUrl ?? null
      },
      guard
    )
  }

  async deletePhoto(userId: number, imageId: number, guard?: () => void): Promise<number> {
    guard?.()
    if (!Number.isSafeInteger(imageId) || imageId <= 0)
      throw new AppError('Invalid image ID.', 'INVALID_INPUT')
    return this.write(
      userId,
      async (wall, transaction) => {
        await this.images.deleteForWall(wall.id, 'photo', imageId, { transaction })
        guard?.()
        const count = await this.images.countForWall(wall.id, 'photo', { transaction })
        guard?.()
        return count
      },
      guard
    )
  }

  async clearPhotos(userId: number, guard?: () => void): Promise<number> {
    return this.write(
      userId,
      async (wall, transaction) => {
        await this.images.deleteForWall(wall.id, 'photo', undefined, { transaction })
        guard?.()
        return 0
      },
      guard
    )
  }

  async exportWallpaper(
    userId: number,
    outputPath: string,
    guard?: () => void,
    limits: PhotoWallLimitsDTO = DEFAULT_LIMITS
  ): Promise<{ photoCount: number }> {
    return withExportDestination(
      outputPath,
      () => this.exportWallpaperInto(userId, outputPath, guard, this.checkedLimits(limits)),
      guard
    )
  }

  private async exportWallpaperInto(
    userId: number,
    outputPath: string,
    guard?: () => void,
    limits: PhotoWallLimitsDTO = DEFAULT_LIMITS
  ): Promise<{ photoCount: number }> {
    guard?.()
    // At most 200 photos plus portrait and preview copies; cumulative pixels and total deadline still have explicit caps.
    const budget = this.imageBudget(guard, (PHOTOWALL_MAX_IMAGES + 2) * 32_000_000, 300_000)
    const parentPath = dirname(outputPath)
    const parentRealPath = await realpath(parentPath)
    guard?.()
    const parent = await stat(parentPath)
    guard?.()
    if (!parent.isDirectory()) throw new AppError('Invalid export directory.', 'INVALID_INPUT')
    const inspect = async (path: string): Promise<Stats | null> =>
      lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
    const sameFile = (actual: Stats | null, expected: Stats): boolean =>
      actual !== null &&
      actual.isFile() &&
      !actual.isSymbolicLink() &&
      actual.dev === expected.dev &&
      actual.ino === expected.ino &&
      actual.birthtimeMs === expected.birthtimeMs
    const removeOwned = async (path: string, identity: Stats): Promise<void> => {
      const current = await inspect(path)
      if (!current) return
      if (!sameFile(current, identity))
        throw new AppError('Export file changed during cleanup.', 'INVALID_INPUT')
      await unlink(path)
    }
    const removeOwnedSync = (path: string, identity: Stats): void => {
      let current: Stats
      try {
        current = lstatSync(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      if (!sameFile(current, identity))
        throw new AppError('Export file changed during cleanup.', 'INVALID_INPUT')
      unlinkSync(path)
    }
    const verifyDestination = async (): Promise<Stats | null> => {
      guard?.()
      const currentRealPath = await realpath(parentPath)
      guard?.()
      const current = await stat(parentPath)
      guard?.()
      if (
        currentRealPath !== parentRealPath ||
        current.dev !== parent.dev ||
        current.ino !== parent.ino ||
        !current.isDirectory()
      ) {
        throw new AppError('Export directory changed.', 'INVALID_INPUT')
      }
      const destination = await inspect(outputPath)
      guard?.()
      if (destination && (!destination.isFile() || destination.isSymbolicLink())) {
        throw new AppError('Invalid export destination.', 'INVALID_INPUT')
      }
      return destination
    }
    // Snapshot the destination directory identity so any concurrent change is detected.
    await verifyDestination()
    guard?.()
    const tmpPath = `${outputPath}.${randomUUID()}.tmp`
    const backupPath = `${outputPath}.${randomUUID()}.previous`
    let temporaryFile: Awaited<ReturnType<typeof open>> | undefined
    let temporaryIdentity: Stats | undefined
    let previousIdentity: Stats | null = null
    let backupCreated = false
    let installed = false
    try {
      // Stream the wallpaper ZIP into a temporary file in the same directory.
      temporaryFile = await open(tmpPath, 'wx', 0o600)
      temporaryIdentity = await temporaryFile.stat()
      guard?.()
      const result = await this.read(
        userId,
        async (wall, transaction) => {
          const metadata = await this.checkedMetadata(
            wall.id,
            transaction,
            guard,
            undefined,
            limits
          )
          guard?.()
          const photos = metadata.filter((image) => image.type === 'photo')
          const portrait = metadata.find((image) => image.type === 'portrait')
          const imageFiles = photos.map(
            (image, index) => `images/photo_${String(index).padStart(3, '0')}.${image.extension}`
          )
          const portraitFile = portrait ? `images/portrait.${portrait.extension}` : null
          await verifyDestination()
          guard?.()
          const zip = new yazl.ZipFile()
          const output = zip.outputStream as Readable
          const active = new Set<Readable>()
          const pending = new Set<Promise<void>>()
          // Establish backpressure and error handling before registering lazy entries; yazl may invoke the first read callback immediately.
          const completion = pipeline(output, temporaryFile!.createWriteStream())
          zip.on('error', (error: Error) => output.destroy(error))
          output.once('close', () => {
            for (const stream of active) stream.destroy()
          })
          const addImage = (meta: ImageMetadata, name: string): void => {
            zip.addReadStreamLazy(name, { size: meta.bytes }, (callback) => {
              const load = this.imageStream(wall.id, meta, transaction, guard, budget).then(
                (stream) => {
                  if (output.destroyed) {
                    stream.destroy()
                    return
                  }
                  active.add(stream)
                  stream.once('error', (error: Error) => output.destroy(error))
                  stream.once('close', () => active.delete(stream))
                  callback(null, stream)
                },
                (error: Error) => {
                  callback(error, undefined!)
                }
              )
              pending.add(load)
              void load
                .finally(() => pending.delete(load))
                .catch((error: Error) => output.destroy(error))
            })
          }
          try {
            photos.forEach((image, index) => addImage(image, imageFiles[index]))
            if (portrait && portraitFile) addImage(portrait, portraitFile)
            const preview = portrait ?? photos[0]
            if (preview) addImage(preview, `preview.${preview.extension}`)
            zip.addBuffer(Buffer.from(buildIndexHtml(), 'utf8'), 'index.html')
            zip.addBuffer(Buffer.from(buildStyleCss(wall.rounded), 'utf8'), 'style.css')
            zip.addBuffer(
              Buffer.from(buildWallpaperJs(imageFiles, portraitFile), 'utf8'),
              'wallpaper.js'
            )
            zip.end()
            await completion
            guard?.()
            return { photoCount: photos.length }
          } catch (error) {
            output.destroy()
            await completion.catch(() => undefined)
            throw error
          } finally {
            for (const stream of active) stream.destroy()
            await Promise.allSettled(pending)
          }
        },
        guard
      )
      // Atomic install: back up the old target, then rename the temporary file into place.
      await temporaryFile.close()
      guard?.()
      previousIdentity = await verifyDestination()
      if (previousIdentity) {
        // link atomically creates a non-overwriting backup copy; the old target stays readable until install.
        await link(outputPath, backupPath)
        backupCreated = true
        guard?.()
        if (!sameFile(await inspect(backupPath), previousIdentity))
          throw new AppError('Export destination changed.', 'INVALID_INPUT')
      }
      const destination = await verifyDestination()
      const unchanged = previousIdentity
        ? sameFile(destination, previousIdentity)
        : destination === null
      if (!unchanged) {
        throw new AppError('Export destination changed.', 'INVALID_INPUT')
      }
      guard?.()
      // Re-verifying path identity cannot eliminate TOCTOU from a malicious local directory swap; rollback only touches files with verified identity.
      await rename(tmpPath, outputPath)
      installed = true
      guard?.()
      if (!sameFile(await inspect(outputPath), temporaryIdentity))
        throw new AppError('Export destination changed.', 'INVALID_INPUT')
      guard?.()
      // Keep the old target until the final guard. Do not yield after this
      // decision: revocation during asynchronous backup cleanup must not leave
      // a published plaintext ZIP while the caller reports cancellation.
      if (backupCreated && previousIdentity) {
        removeOwnedSync(backupPath, previousIdentity)
        backupCreated = false
      }
      return result
    } catch (error) {
      // Roll back every artifact that may have been touched, collecting each cleanup error.
      const failures: unknown[] = [error]
      try {
        await temporaryFile?.close()
      } catch (cleanupError) {
        failures.push(cleanupError)
      }
      try {
        if (installed && temporaryIdentity) await removeOwned(outputPath, temporaryIdentity)
        if (backupCreated && previousIdentity) {
          const current = await inspect(outputPath)
          if (!sameFile(current, previousIdentity)) {
            // Restoration must also use non-overwriting link, so it cannot overwrite a file installed by another operation during export.
            await link(backupPath, outputPath)
          }
          await removeOwned(backupPath, previousIdentity)
          backupCreated = false
        }
      } catch (cleanupError) {
        failures.push(cleanupError)
      }
      try {
        if (temporaryIdentity) await removeOwned(tmpPath, temporaryIdentity)
      } catch (cleanupError) {
        failures.push(cleanupError)
      }
      if (failures.length > 1)
        // eslint-disable-next-line preserve-caught-error
        throw new AggregateError(failures, 'Wallpaper export rollback or cleanup failed.')
      throw error
    }
  }

  private async imageStream(
    wallId: number,
    meta: ImageMetadata,
    transaction: Transaction,
    guard: Guard,
    budget: ImageValidationBudget
  ): Promise<Readable> {
    guard?.()
    const row = await this.images.findForWall(wallId, meta.id, { transaction })
    guard?.()
    if (!row || row.type !== meta.type) throw new AppError('Image changed.', 'INVALID_INPUT')
    const { bytes } = await validateImageDataUrl(
      row.dataUrl,
      meta.type === 'photo' ? PHOTOWALL_IMAGE_HARD_MAX_BYTES : PHOTOWALL_PORTRAIT_MAX_BYTES,
      budget
    )
    try {
      guard?.()
      if (bytes.length !== meta.bytes) throw new AppError('Image changed.', 'INVALID_INPUT')
      const stream = Readable.from(
        (function* () {
          try {
            for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
              guard?.()
              yield Buffer.from(bytes.subarray(offset, offset + 64 * 1024))
            }
            guard?.()
          } finally {
            bytes.fill(0)
          }
        })(),
        { objectMode: false, highWaterMark: 64 * 1024 }
      )
      stream.once('close', () => bytes.fill(0))
      return stream
    } catch (error) {
      bytes.fill(0)
      throw error
    }
  }

  private checkedLimits(limits: PhotoWallLimitsDTO): PhotoWallLimitsDTO {
    const parsed = PhotoWallLimitsSchema.safeParse(limits)
    if (!parsed.success) throw new AppError('Invalid photo wall limits.', 'INVALID_INPUT')
    return parsed.data
  }

  private inputBytes(dataUrl: string, maxBytes: number): number {
    if (typeof dataUrl !== 'string') throw new AppError('Invalid image.', 'INVALID_INPUT')
    const prefix = /^data:image\/(?:png|jpeg|gif|webp);base64,/.exec(dataUrl)
    if (!prefix) throw new AppError('Invalid image.', 'INVALID_INPUT')
    const encoded = dataUrl.length - prefix[0].length
    const padding = dataUrl.endsWith('==') ? 2 : dataUrl.endsWith('=') ? 1 : 0
    const bytes = (encoded / 4) * 3 - padding
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || encoded % 4 !== 0)
      throw new AppError('Invalid image.', 'INVALID_INPUT')
    if (bytes > maxBytes) throw new AppError('Image is too large.', 'IMAGE_TOO_LARGE')
    return bytes
  }

  private imageBudget(
    guard: Guard,
    maxPixels = 256_000_000,
    timeoutMs = 30_000
  ): ImageValidationBudget {
    return createImageValidationBudget({ maxPixels, timeoutMs, assertActive: guard })
  }

  private async validateImage(
    dataUrl: string,
    maxBytes: number,
    guard: Guard,
    budget = this.imageBudget(guard)
  ): Promise<{ dataUrl: string; bytes: number }> {
    guard?.()
    const image = await validateImageDataUrl(dataUrl, maxBytes, budget)
    try {
      guard?.()
      return { dataUrl: image.dataUrl, bytes: image.bytes.length }
    } finally {
      image.bytes.fill(0)
    }
  }

  private async checkedMetadata(
    wallId: number,
    transaction: Transaction,
    guard: Guard,
    type?: 'photo',
    limits: PhotoWallLimitsDTO = DEFAULT_LIMITS
  ): Promise<ImageMetadata[]> {
    guard?.()
    // Phase 1: aggregate stored sizes via SQL and reject inconsistent counts/sizes up front.
    const measured = await this.images.measureForWall(wallId, type, { transaction })
    guard?.()
    if (
      !Number.isSafeInteger(measured.count) ||
      measured.count < 0 ||
      !Number.isSafeInteger(measured.characters) ||
      measured.characters < 0 ||
      !Number.isSafeInteger(measured.maxLength) ||
      measured.maxLength < 0 ||
      measured.count > PHOTOWALL_MAX_IMAGES + (type ? 0 : 1) ||
      measured.maxLength >
        Math.ceil((type ? PHOTOWALL_IMAGE_HARD_MAX_BYTES : PHOTOWALL_PORTRAIT_MAX_BYTES) / 3) * 4 +
          32
    ) {
      throw new AppError('Photo wall exceeds storage limits.', 'INVALID_INPUT')
    }
    if (measured.characters > Math.ceil(limits.totalMaxBytes / 3) * 4 + measured.count * 32)
      throw new AppError('Photo wall exceeds capacity.', 'PHOTOWALL_CAPACITY_EXCEEDED')
    // Phase 2: load per-image metadata and re-derive byte lengths from the stored data URL.
    const rows = await this.images.metadataForWall(wallId, type, { transaction })
    guard?.()
    if (rows.length !== measured.count)
      throw new AppError('Invalid stored image count.', 'INVALID_INPUT')
    let total = 0
    let photoCount = 0
    let portraitCount = 0
    const result = rows.map((row): ImageMetadata => {
      const match = /^data:image\/(png|jpeg|gif|webp);base64,/.exec(row.prefix)
      if (
        !match ||
        (row.type !== 'photo' && row.type !== 'portrait') ||
        !Number.isSafeInteger(row.id) ||
        row.id <= 0 ||
        !Number.isSafeInteger(row.length) ||
        row.length < 1 ||
        !/^[A-Za-z0-9+/]*$/.test(row.prefix.slice(match[0].length)) ||
        !/^[A-Za-z0-9+/]{2}$|^[A-Za-z0-9+/]=$|^==$/.test(row.suffix)
      )
        throw new AppError('Invalid stored image.', 'INVALID_INPUT')
      const encoded = row.length - match[0].length
      const padding = row.suffix.endsWith('==') ? 2 : row.suffix.endsWith('=') ? 1 : 0
      const bytes = (encoded / 4) * 3 - padding
      if (
        encoded <= 0 ||
        encoded % 4 !== 0 ||
        !Number.isSafeInteger(bytes) ||
        bytes <= 0 ||
        bytes >
          (row.type === 'photo' ? PHOTOWALL_IMAGE_HARD_MAX_BYTES : PHOTOWALL_PORTRAIT_MAX_BYTES)
      ) {
        throw new AppError('Invalid stored image size.', 'INVALID_INPUT')
      }
      total += bytes
      if (row.type === 'photo') photoCount++
      else portraitCount++
      return { ...row, bytes, extension: match[1] === 'jpeg' ? 'jpg' : match[1] }
    })
    if (photoCount > PHOTOWALL_MAX_IMAGES || portraitCount > 1) {
      throw new AppError('Photo wall exceeds storage limits.', 'INVALID_INPUT')
    }
    if (total > limits.totalMaxBytes)
      throw new AppError('Photo wall exceeds capacity.', 'PHOTOWALL_CAPACITY_EXCEEDED')
    guard?.()
    return result
  }

  private async requireWall(
    userId: number,
    guard: Guard,
    transaction?: Transaction
  ): Promise<PhotoWall> {
    guard?.()
    const existing = await this.walls.findByUserId(userId, { transaction })
    guard?.()
    if (existing) return existing
    if (transaction) {
      registerTransactionGuard(transaction, guard)
      const created = await this.walls.create({ userId }, { transaction })
      guard?.()
      return created
    }
    const created = await this.walls.transaction(async (writeTransaction) => {
      registerTransactionGuard(writeTransaction, guard)
      const wall = await this.requireWall(userId, guard, writeTransaction)
      guard?.()
      return wall
    })
    guard?.()
    return created
  }

  private async read<T>(
    userId: number,
    operation: (wall: PhotoWall, transaction: Transaction) => Promise<T>,
    guard: Guard
  ): Promise<T> {
    await this.requireWall(userId, guard)
    guard?.()
    const result = await withReadSnapshot(PhotoWall.sequelize!, async (transaction) => {
      guard?.()
      const wall = await this.walls.findByUserId(userId, { transaction })
      guard?.()
      if (!wall) throw new AppError('Photo wall not found.', 'INVALID_INPUT')
      const value = await operation(wall, transaction)
      guard?.()
      return value
    })
    guard?.()
    return result
  }

  private async write<T>(
    userId: number,
    operation: (wall: PhotoWall, transaction: Transaction) => Promise<T>,
    guard: Guard
  ): Promise<T> {
    guard?.()
    const result = await this.walls.transaction(async (transaction) => {
      registerTransactionGuard(transaction, guard)
      guard?.()
      const wall = await this.requireWall(userId, guard, transaction)
      guard?.()
      const value = await operation(wall, transaction)
      guard?.()
      return value
    })
    guard?.()
    return result
  }
}

export default PhotoWallService
