import { randomUUID } from 'node:crypto'
import type { Transaction } from 'sequelize'
import { DIARY_PAGE_SIZE_DEFAULT, DIARY_PAGE_SIZE_MAX } from '@common/diary'
import type {
  CreateDiaryDTO,
  DiaryDTO,
  DiaryImageDTO,
  DiaryImageInputDTO,
  DiaryPageDTO,
  DiaryPageOptionsDTO,
  DiarySummaryDTO,
  UpdateDiaryDTO
} from '@common/diary'
import {
  DIARY_IMAGE_MAX_BYTES,
  DIARY_IMAGES_MAX_BYTES,
  DIARY_MARKDOWN_MAX_BYTES,
  DIARY_MAX_IMAGES
} from '@common/diary-limits'
import { AppError } from '../errors'
import {
  decryptBytes,
  decryptText,
  diaryContentAad,
  diaryImageAad,
  encryptBytes,
  encryptText
} from '../crypto/notebook-crypto'
import type { Diary } from '../database/models/diary.model'
import type { DiaryImage } from '../database/models/diary-image.model'
import DiaryRepository, { type DiaryMetadata } from '../database/repositories/DiaryRepository'
import DiaryImageRepository, {
  type DiaryImageMetadata
} from '../database/repositories/DiaryImageRepository'
import { registerTransactionGuard } from '../database/transaction'
import NotebookService from './NotebookService'
import {
  replaceDiaryImageReferences,
  scanDiaryImageReferences,
  summarizeDiaryContent
} from './diary-content'
import {
  createImageValidationBudget,
  validateImageDataUrl,
  type ImageValidationBudget
} from './image-validation'

const LIST_PREVIEW_MAX_BYTES = 32 * 1024 * 1024
const DRAFT_REFERENCE_PATTERN = /^draft-image:\/\/([A-Za-z0-9_-]{1,80})$/
const SAVED_REFERENCE_PATTERN =
  /^diary-image:\/\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i

interface PreparedImage {
  inputReference: string
  uuid: string
  mimeType: string
  data: Buffer
}

export class DiaryService {
  constructor(
    private readonly notebooks = new NotebookService(),
    private readonly diaries = new DiaryRepository(),
    private readonly images = new DiaryImageRepository()
  ) {}

  async list(
    userId: number,
    notebookId: number,
    dataKey: Buffer,
    guard?: () => void
  ): Promise<DiarySummaryDTO[]> {
    guard?.()
    const result = await this.diaries.readSnapshot(async (transaction) => {
      const notebook = await this.notebooks.requireOwned(userId, notebookId, guard)
      guard?.()
      if (dataKey.length !== 32) throw new AppError('Unlock the notebook first.', 'NOTEBOOK_LOCKED')
      const metadata = await this.diaries.findMetadataInNotebook(notebookId, [], { transaction })
      guard?.()
      return this.buildSummaries(notebook.uuid, notebookId, metadata, dataKey, transaction, guard)
    })
    guard?.()
    return result
  }

  async listPage(
    userId: number,
    notebookId: number,
    dataKey: Buffer,
    options: DiaryPageOptionsDTO = {},
    guard?: () => void
  ): Promise<DiaryPageDTO> {
    guard?.()
    const result = await this.diaries.readSnapshot(async (transaction) => {
      const notebook = await this.notebooks.requireOwned(userId, notebookId, guard)
      guard?.()
      if (dataKey.length !== 32) throw new AppError('Unlock the notebook first.', 'NOTEBOOK_LOCKED')
      const { page = 1, pageSize = DIARY_PAGE_SIZE_DEFAULT } = options
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > Math.floor(Number.MAX_SAFE_INTEGER / DIARY_PAGE_SIZE_MAX) ||
        !Number.isSafeInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > DIARY_PAGE_SIZE_MAX ||
        !Number.isSafeInteger((page - 1) * pageSize)
      )
        throw new AppError('Invalid diary pagination options.', 'INVALID_INPUT')
      const total = await this.diaries.countInNotebook(notebookId, { transaction })
      guard?.()
      const actualPage = Math.min(page, Math.max(1, Math.ceil(total / pageSize)))
      if (total === 0) return { items: [], total, page: 1, pageSize }
      const metadata = await this.diaries.findMetadataInNotebook(notebookId, [], {
        transaction,
        limit: pageSize,
        offset: (actualPage - 1) * pageSize
      })
      guard?.()
      const items = await this.buildSummaries(
        notebook.uuid,
        notebookId,
        metadata,
        dataKey,
        transaction,
        guard
      )
      guard?.()
      return { items, total, page: actualPage, pageSize }
    })
    guard?.()
    return result
  }

  private async buildSummaries(
    notebookUuid: string,
    notebookId: number,
    metadata: DiaryMetadata[],
    dataKey: Buffer,
    transaction: Transaction,
    guard?: () => void
  ): Promise<DiarySummaryDTO[]> {
    const summaries: DiarySummaryDTO[] = []
    let previewBytesRemaining = LIST_PREVIEW_MAX_BYTES
    for (const entry of metadata) {
      let summary = this.toSummary(entry)
      // Each list read has an independent preview budget; damaged, oversized or over-budget entries still keep their metadata card.
      if (
        Number.isSafeInteger(entry.contentByteLength) &&
        entry.contentByteLength >= 0 &&
        entry.contentByteLength <= DIARY_MARKDOWN_MAX_BYTES &&
        entry.contentByteLength <= previewBytesRemaining
      ) {
        previewBytesRemaining -= entry.contentByteLength
        const diary = await this.diaries.findInNotebook(notebookId, entry.id, { transaction })
        guard?.()
        if (diary) {
          try {
            const markdown = decryptText(
              {
                ciphertext: diary.contentCiphertext,
                nonce: diary.contentNonce,
                tag: diary.contentTag
              },
              dataKey,
              diaryContentAad(notebookUuid, diary.uuid, diary.occurredAt.toISOString())
            )
            summary = { ...summary, ...summarizeDiaryContent(markdown) }
          } catch {
            // A single auth failure does not affect other cards; the guard is checked outside the catch.
          }
        }
      }
      guard?.()
      summaries.push(summary)
    }
    guard?.()
    return summaries
  }

  async get(
    userId: number,
    notebookId: number,
    diaryId: number,
    dataKey: Buffer,
    guard?: () => void
  ): Promise<DiaryDTO> {
    guard?.()
    const budget = createImageValidationBudget({ assertActive: guard })
    const result = await this.diaries.readSnapshot(async (transaction) => {
      const notebook = await this.notebooks.requireOwned(userId, notebookId, guard)
      guard?.()
      const metadata = await this.diaries.findMetadataInNotebook(notebookId, [diaryId], {
        transaction
      })
      guard?.()
      if (!metadata.length) throw new AppError('Diary not found.', 'DIARY_NOT_FOUND')
      if (
        metadata[0].contentByteLength < 0 ||
        metadata[0].contentByteLength > DIARY_MARKDOWN_MAX_BYTES
      )
        throw new AppError('Stored diary content exceeds the supported limit.', 'DIARY_TOO_LARGE')
      const imageMetadata = await this.images.findMetadataForDiary(diaryId, {
        transaction,
        limit: DIARY_MAX_IMAGES + 1
      })
      guard?.()
      this.assertImageBudget(imageMetadata)
      const diary = await this.diaries.findInNotebook(notebookId, diaryId, { transaction })
      guard?.()
      if (!diary) throw new AppError('Diary not found.', 'DIARY_NOT_FOUND')
      const images = await this.images.findAllForDiary(diaryId, { transaction })
      guard?.()
      const dto = await this.toDto(notebook.uuid, diary, images, dataKey, guard, budget)
      guard?.()
      return dto
    })
    guard?.()
    return result
  }

  async create(
    userId: number,
    input: CreateDiaryDTO,
    dataKey: Buffer,
    guard?: () => void
  ): Promise<DiaryDTO> {
    guard?.()
    const budget = createImageValidationBudget({ assertActive: guard })
    const notebook = await this.notebooks.requireOwned(userId, input.notebookId, guard)
    guard?.()
    const prepared = await this.prepareImages(input.markdown, input.images, guard, budget)
    try {
      guard?.()
      if (this.savedReferences(input.markdown).size > 0)
        throw new AppError('A new diary cannot reuse persisted image references.', 'INVALID_INPUT')
      const diaryUuid = randomUUID()
      const occurredAt = new Date(input.occurredAt)
      const markdown = this.replaceDraftReferences(input.markdown, prepared)
      if (Buffer.byteLength(markdown, 'utf8') > DIARY_MARKDOWN_MAX_BYTES)
        throw new AppError('Diary content is too large.', 'DIARY_TOO_LARGE')
      guard?.()
      const encrypted = encryptText(
        markdown,
        dataKey,
        diaryContentAad(notebook.uuid, diaryUuid, occurredAt.toISOString())
      )
      // Persist the encrypted body and each encrypted image under a single transaction.
      const result = await this.diaries.transaction(async (transaction) => {
        registerTransactionGuard(transaction, guard)
        guard?.()
        const diary = await this.diaries.create(
          {
            uuid: diaryUuid,
            notebookId: notebook.id,
            occurredAt,
            contentCiphertext: encrypted.ciphertext,
            contentNonce: encrypted.nonce,
            contentTag: encrypted.tag
          },
          { transaction }
        )
        guard?.()
        for (const image of prepared) {
          guard?.()
          const value = encryptBytes(
            image.data,
            dataKey,
            diaryImageAad(notebook.uuid, diaryUuid, image.uuid, image.mimeType)
          )
          await this.images.create(
            {
              uuid: image.uuid,
              diaryId: diary.id,
              mimeType: image.mimeType,
              byteLength: image.data.length,
              ciphertext: value.ciphertext,
              nonce: value.nonce,
              tag: value.tag
            },
            { transaction }
          )
          guard?.()
        }
        const storedImages = await this.images.findAllForDiary(diary.id, { transaction })
        guard?.()
        const dto = await this.toDto(
          notebook.uuid,
          diary,
          storedImages,
          dataKey,
          guard,
          budget,
          prepared
        )
        guard?.()
        return dto
      })
      guard?.()
      return result
    } finally {
      for (const image of prepared) image.data.fill(0)
    }
  }

  async update(
    userId: number,
    input: UpdateDiaryDTO,
    dataKey: Buffer,
    guard?: () => void
  ): Promise<DiaryDTO> {
    guard?.()
    const budget = createImageValidationBudget({ assertActive: guard })
    const notebook = await this.notebooks.requireOwned(userId, input.notebookId, guard)
    guard?.()
    const prepared = await this.prepareImages(input.markdown, input.images, guard, budget)
    try {
      guard?.()
      const result = await this.diaries.transaction(async (transaction) => {
        registerTransactionGuard(transaction, guard)
        guard?.()
        // Check the old record size first; oversized ciphertext must be rejected before the repository loads the original instance.
        const metadata = await this.diaries.findMetadataInNotebook(notebook.id, [input.diaryId], {
          transaction
        })
        guard?.()
        if (!metadata.length) throw new AppError('Diary not found.', 'DIARY_NOT_FOUND')
        const diary = metadata[0]
        if (diary.contentByteLength < 0 || diary.contentByteLength > DIARY_MARKDOWN_MAX_BYTES)
          throw new AppError('Stored diary content exceeds the supported limit.', 'DIARY_TOO_LARGE')
        const existing = await this.images.findMetadataForDiary(diary.id, {
          transaction,
          limit: DIARY_MAX_IMAGES + 1
        })
        guard?.()
        this.assertImageBudget(existing)
        // Reconcile the retained images against the existing set, then delete removed ones and add new ones.
        const retained = this.savedReferences(input.markdown)
        const owned = new Set(existing.map((image) => image.uuid))
        if ([...retained].some((uuid) => !owned.has(uuid)))
          throw new AppError('Diary references an image from another record.', 'INVALID_INPUT')
        const retainedImages = existing.filter((image) => retained.has(image.uuid))
        this.assertImageBudget(retainedImages, prepared)
        const occurredAt = new Date(input.occurredAt)
        const markdown = this.replaceDraftReferences(input.markdown, prepared)
        if (Buffer.byteLength(markdown, 'utf8') > DIARY_MARKDOWN_MAX_BYTES)
          throw new AppError('Diary content is too large.', 'DIARY_TOO_LARGE')
        guard?.()
        const encrypted = encryptText(
          markdown,
          dataKey,
          diaryContentAad(notebook.uuid, diary.uuid, occurredAt.toISOString())
        )
        const updated = await this.diaries.update(
          diary.id,
          {
            occurredAt,
            contentCiphertext: encrypted.ciphertext,
            contentNonce: encrypted.nonce,
            contentTag: encrypted.tag
          },
          { transaction }
        )
        guard?.()
        if (!updated) throw new AppError('Diary not found.', 'DIARY_NOT_FOUND')
        for (const image of existing) {
          if (!retained.has(image.uuid)) {
            await this.images.deleteInDiary(diary.id, image.id, { transaction })
            guard?.()
          }
        }
        for (const image of prepared) {
          guard?.()
          const value = encryptBytes(
            image.data,
            dataKey,
            diaryImageAad(notebook.uuid, diary.uuid, image.uuid, image.mimeType)
          )
          await this.images.create(
            {
              uuid: image.uuid,
              diaryId: diary.id,
              mimeType: image.mimeType,
              byteLength: image.data.length,
              ciphertext: value.ciphertext,
              nonce: value.nonce,
              tag: value.tag
            },
            { transaction }
          )
          guard?.()
        }
        const refreshed = await this.diaries.findInNotebook(notebook.id, diary.id, { transaction })
        guard?.()
        if (!refreshed) throw new AppError('Diary not found.', 'DIARY_NOT_FOUND')
        const storedImages = await this.images.findAllForDiary(diary.id, { transaction })
        guard?.()
        const dto = await this.toDto(
          notebook.uuid,
          refreshed,
          storedImages,
          dataKey,
          guard,
          budget,
          prepared
        )
        guard?.()
        return dto
      })
      guard?.()
      return result
    } finally {
      for (const image of prepared) image.data.fill(0)
    }
  }

  async delete(
    userId: number,
    notebookId: number,
    diaryId: number,
    guard?: () => void
  ): Promise<boolean> {
    guard?.()
    await this.notebooks.requireOwned(userId, notebookId, guard)
    guard?.()
    const result = await this.diaries.transaction(async (transaction) => {
      registerTransactionGuard(transaction, guard)
      guard?.()
      const metadata = await this.diaries.findMetadataInNotebook(notebookId, [diaryId], {
        transaction
      })
      guard?.()
      if (!metadata.length) return false
      // Cleanup must remain possible for damaged/oversized old ciphertext.
      // Both child deletion and the scoped parent deletion avoid loading TEXT.
      await this.images.deleteAllForDiary(diaryId, { transaction })
      guard?.()
      const deleted = await this.diaries.deleteInNotebook(notebookId, diaryId, { transaction })
      guard?.()
      return deleted
    })
    guard?.()
    return result
  }

  private assertImageBudget(existing: DiaryImageMetadata[], prepared: PreparedImage[] = []): void {
    let totalBytes = prepared.reduce((sum, image) => sum + image.data.length, 0)
    if (existing.length + prepared.length > DIARY_MAX_IMAGES)
      throw new AppError('Too many diary images.', 'DIARY_TOO_LARGE')
    for (const image of existing) {
      if (
        !Number.isSafeInteger(image.byteLength) ||
        image.byteLength <= 0 ||
        image.byteLength > DIARY_IMAGE_MAX_BYTES ||
        image.ciphertextByteLength !== image.byteLength
      )
        throw new AppError(
          'Stored diary image exceeds the supported limit or is damaged.',
          'DIARY_TOO_LARGE'
        )
      totalBytes += image.byteLength
    }
    if (totalBytes > DIARY_IMAGES_MAX_BYTES)
      throw new AppError('Diary images are too large.', 'DIARY_TOO_LARGE')
  }

  private async prepareImages(
    markdown: string,
    inputs: DiaryImageInputDTO[],
    guard?: () => void,
    budget: ImageValidationBudget = createImageValidationBudget({ assertActive: guard })
  ): Promise<PreparedImage[]> {
    guard?.()
    if (Buffer.byteLength(markdown, 'utf8') > DIARY_MARKDOWN_MAX_BYTES)
      throw new AppError('Diary content is too large.', 'DIARY_TOO_LARGE')
    if (inputs.length > DIARY_MAX_IMAGES)
      throw new AppError('Too many diary images.', 'DIARY_TOO_LARGE')
    const references = new Set<string>()
    const prepared: PreparedImage[] = []
    let totalBytes = 0
    try {
      for (const input of inputs) {
        guard?.()
        if (!DRAFT_REFERENCE_PATTERN.test(input.reference) || references.has(input.reference))
          throw new AppError('Invalid diary image reference.', 'INVALID_INPUT')
        references.add(input.reference)
        const validated = await validateImageDataUrl(input.dataUrl, DIARY_IMAGE_MAX_BYTES, budget)
        try {
          guard?.()
          if (validated.mimeType !== input.mimeType)
            throw new AppError('Invalid diary image MIME type.', 'INVALID_INPUT')
          totalBytes += validated.bytes.length
          if (totalBytes > DIARY_IMAGES_MAX_BYTES)
            throw new AppError('Diary images are too large.', 'DIARY_TOO_LARGE')
          prepared.push({
            inputReference: input.reference,
            uuid: randomUUID(),
            mimeType: validated.mimeType,
            data: validated.bytes
          })
        } catch (error) {
          validated.bytes.fill(0)
          throw error
        }
      }
      const referencedDrafts = new Set(
        scanDiaryImageReferences(markdown)
          .map((token) => token.reference)
          .filter((reference) => reference.startsWith('draft-image://'))
      )
      if (
        referencedDrafts.size !== references.size ||
        [...referencedDrafts].some((reference) => !references.has(reference))
      )
        throw new AppError('Diary image data does not match Markdown.', 'INVALID_INPUT')
      guard?.()
      return prepared
    } catch (error) {
      for (const image of prepared) image.data.fill(0)
      guard?.()
      throw error
    }
  }

  private replaceDraftReferences(markdown: string, images: PreparedImage[]): string {
    return replaceDiaryImageReferences(
      markdown,
      new Map(images.map((image) => [image.inputReference, `diary-image://${image.uuid}`]))
    )
  }

  private savedReferences(markdown: string): Set<string> {
    const result = new Set<string>()
    for (const token of scanDiaryImageReferences(markdown)) {
      const uuid = SAVED_REFERENCE_PATTERN.exec(token.reference)?.[1]
      if (uuid) result.add(uuid.toLowerCase())
      else if (token.reference.startsWith('diary-image://'))
        throw new AppError('Invalid persisted image reference.', 'INVALID_INPUT')
    }
    return result
  }

  private toSummary(diary: DiaryMetadata | Diary): DiarySummaryDTO {
    return {
      id: diary.id,
      uuid: diary.uuid,
      notebookId: diary.notebookId,
      occurredAt: diary.occurredAt.toISOString(),
      createdAt: diary.createdAt.toISOString(),
      updatedAt: diary.updatedAt.toISOString()
    }
  }

  private async toDto(
    notebookUuid: string,
    diary: Diary,
    images: DiaryImage[],
    dataKey: Buffer,
    guard?: () => void,
    budget: ImageValidationBudget = createImageValidationBudget({ assertActive: guard }),
    prevalidated: PreparedImage[] = []
  ): Promise<DiaryDTO> {
    guard?.()
    budget.assertActive()
    const markdown = decryptText(
      { ciphertext: diary.contentCiphertext, nonce: diary.contentNonce, tag: diary.contentTag },
      dataKey,
      diaryContentAad(notebookUuid, diary.uuid, diary.occurredAt.toISOString())
    )
    guard?.()
    const imageDtos: DiaryImageDTO[] = []
    try {
      for (const image of images) {
        guard?.()
        const bytes = decryptBytes(
          { ciphertext: image.ciphertext, nonce: image.nonce, tag: image.tag },
          dataKey,
          diaryImageAad(notebookUuid, diary.uuid, image.uuid, image.mimeType)
        )
        try {
          guard?.()
          if (bytes.length !== image.byteLength)
            throw new AppError('Encrypted diary image is damaged.', 'DIARY_DATA_DAMAGED')
          const dataUrl = `data:${image.mimeType};base64,${bytes.toString('base64')}`
          let validated: Awaited<ReturnType<typeof validateImageDataUrl>> | undefined
          try {
            // Do not decode new uploads twice. Skip only when authenticated
            // stored bytes exactly match this operation's fully validated input.
            const known = prevalidated.find(
              (item) => item.uuid === image.uuid && item.mimeType === image.mimeType
            )
            if (!known || !bytes.equals(known.data)) {
              try {
                validated = await validateImageDataUrl(dataUrl, DIARY_IMAGE_MAX_BYTES, budget)
              } catch {
                guard?.()
                budget.assertActive()
                throw new AppError('Encrypted diary image is damaged.', 'DIARY_DATA_DAMAGED')
              }
            }
            budget.assertActive()
            guard?.()
            imageDtos.push({
              reference: `diary-image://${image.uuid}`,
              mimeType: image.mimeType,
              dataUrl
            })
          } finally {
            validated?.bytes.fill(0)
          }
        } finally {
          bytes.fill(0)
        }
      }
      guard?.()
      return { ...this.toSummary(diary), markdown, images: imageDtos }
    } catch (error) {
      for (const image of imageDtos) image.dataUrl = ''
      throw error
    }
  }
}

export default DiaryService
