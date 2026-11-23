import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, rmSync } from 'node:fs'
import { chmod, lstat, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { finished, pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import { types } from 'node:util'
import * as yazl from 'yazl'
import * as yauzl from 'yauzl'
import type { Transaction } from 'sequelize'
import { ZodError } from 'zod'
import type {
  BackupExportResultDTO,
  BackupImportResultDTO,
  DiaryImageInputDTO
} from '@common/diary'
import {
  BACKUP_MAX_COMPRESSION_RATIO,
  BACKUP_MAX_ENTRIES,
  BACKUP_MAX_ENTRY_BYTES,
  BACKUP_MAX_UNCOMPRESSED_BYTES,
  DIARY_IMAGE_MAX_BYTES,
  DIARY_IMAGES_MAX_BYTES,
  DIARY_MARKDOWN_MAX_BYTES,
  DIARY_MAX_IMAGES
} from '@common/diary-limits'
import { AppError } from '../errors'
import {
  decryptBytes,
  diaryContentAad,
  diaryImageAad,
  encryptBytes,
  createDataKey,
  wrapDataKey,
  unwrapDataKey
} from '../crypto/notebook-crypto'
import DiaryRepository from '../database/repositories/DiaryRepository'
import DiaryImageRepository, {
  type DiaryImageMetadata
} from '../database/repositories/DiaryImageRepository'
import NotebookRepository from '../database/repositories/NotebookRepository'
import { registerTransactionGuard } from '../database/transaction'
import NotebookService from './NotebookService'
import DiaryService from './DiaryService'
import { replaceDiaryImageReferences, scanDiaryImageReferences } from './diary-content'
import { createImageValidationBudget, validateImageDataUrl } from './image-validation'
import { withExportDestination } from './export-destination'
import {
  BACKUP_HEADER_ENTRY,
  BACKUP_MANIFEST_ENTRY,
  BACKUP_MAX_HEADER_BYTES,
  BACKUP_MAX_MANIFEST_BYTES,
  BackupHeaderSchema,
  BackupUnsignedHeaderSchema,
  BackupManifestSchema,
  DIARY_BACKUP_FORMAT,
  DIARY_BACKUP_VERSION,
  backupDiaryAad,
  backupImageAad,
  backupManifestAad,
  canonicalHeaderWithoutManifest,
  headerEnvelope,
  sha256,
  withoutCiphertext,
  type BackupHeader,
  type BackupManifest
} from '../backup/format'

interface TemporaryEntry {
  path: string
  aad: string
  encryption: { nonce: string; tag: string }
}
interface ExtractedEntry extends TemporaryEntry {
  size: number
}
interface ValidatedDiary {
  occurredAt: string
  markdown: TemporaryEntry
  images: Array<{ uuid: string; mimeType: string; entry: TemporaryEntry }>
}

export class DiaryBackupService {
  constructor(
    private readonly notebooks = new NotebookService(),
    private readonly notebookRepository = new NotebookRepository(),
    private readonly diaries = new DiaryRepository(),
    private readonly images = new DiaryImageRepository(),
    private readonly diaryService = new DiaryService()
  ) {}

  async exportBackup(
    userId: number,
    notebookId: number,
    diaryIds: number[] | undefined,
    dataKey: Buffer,
    outputPath: string,
    guard?: () => void
  ): Promise<BackupExportResultDTO> {
    guard?.()
    const admittedKey = Buffer.from(dataKey)
    try {
      return await withExportDestination(
        outputPath,
        () => this.exportBackupInto(userId, notebookId, diaryIds, admittedKey, outputPath, guard),
        guard
      )
    } finally {
      admittedKey.fill(0)
    }
  }

  private async exportBackupInto(
    userId: number,
    notebookId: number,
    diaryIds: number[] | undefined,
    dataKey: Buffer,
    outputPath: string,
    guard?: () => void
  ): Promise<BackupExportResultDTO> {
    guard?.()
    const operationKey = Buffer.from(dataKey)
    let workDir: string | undefined
    let archivePath: string | undefined
    try {
      await this.assertSafeExportPath(outputPath)
      guard?.()
      await this.notebooks.requireOwned(userId, notebookId, guard)
      guard?.()
      workDir = await mkdtemp(join(tmpdir(), 'myapp-diary-export-'))
      guard?.()
      await chmod(workDir, 0o700)
      guard?.()
      const directory = workDir
      archivePath = join(dirname(outputPath), `.${basename(outputPath)}.${randomUUID()}.tmp`)
      // Load only metadata in the snapshot; after the budget passes, read, decrypt and re-encrypt each ciphertext to disk.
      const staged = await this.diaries.readSnapshot(async (transaction) => {
        try {
          const notebook = await this.notebookRepository.findOwnedById(userId, notebookId, {
            transaction
          })
          guard?.()
          if (!notebook) throw new AppError('Notebook not found.', 'NOTEBOOK_NOT_FOUND')
          const selected = await this.diaries.findMetadataInNotebook(notebookId, diaryIds ?? [], {
            transaction,
            limit: BACKUP_MAX_ENTRIES + 1
          })
          guard?.()
          if (diaryIds?.length && selected.length !== diaryIds.length)
            throw new AppError('One or more diaries were not found.', 'DIARY_NOT_FOUND')
          if (selected.length + 2 > BACKUP_MAX_ENTRIES)
            throw new AppError('Diary backup is too large.', 'DIARY_TOO_LARGE')
          const imagesByDiary = new Map<number, DiaryImageMetadata[]>()
          let entryCount = 2 + selected.length
          let totalBytes = 0
          for (const diary of selected) {
            if (
              !Number.isSafeInteger(diary.contentByteLength) ||
              diary.contentByteLength < 0 ||
              diary.contentByteLength > DIARY_MARKDOWN_MAX_BYTES ||
              diary.contentByteLength > BACKUP_MAX_ENTRY_BYTES
            )
              throw new AppError('Stored diary exceeds backup limits.', 'DIARY_TOO_LARGE')
            totalBytes += diary.contentByteLength
            const images = await this.images.findMetadataForDiary(diary.id, {
              transaction,
              limit: DIARY_MAX_IMAGES + 1
            })
            guard?.()
            this.assertImageMetadata(images)
            entryCount += images.length
            totalBytes += images.reduce((sum, image) => sum + image.byteLength, 0)
            if (entryCount > BACKUP_MAX_ENTRIES || totalBytes > BACKUP_MAX_UNCOMPRESSED_BYTES)
              throw new AppError('Diary backup is too large.', 'DIARY_TOO_LARGE')
            imagesByDiary.set(diary.id, images)
          }
          // Build the header and manifest with placeholder encryption metadata, then pre-flight the archive budget.
          const envelope = this.notebooks.envelope(notebook)
          const unsignedHeader = BackupUnsignedHeaderSchema.parse({
            ...envelope,
            format: DIARY_BACKUP_FORMAT,
            version: DIARY_BACKUP_VERSION,
            sourceNotebookUuid: notebook.uuid,
            sourceUserId: notebook.userId
          })
          const placeholderEncryption = {
            nonce: Buffer.alloc(12).toString('base64'),
            tag: Buffer.alloc(16).toString('base64')
          }
          const placeholderHeader = BackupHeaderSchema.parse({
            ...unsignedHeader,
            manifest: placeholderEncryption
          })
          const manifest: BackupManifest = {
            format: DIARY_BACKUP_FORMAT,
            version: DIARY_BACKUP_VERSION,
            notebookName: notebook.name,
            exportedAt: new Date().toISOString(),
            diaries: selected.map((diary) => ({
              uuid: diary.uuid,
              occurredAt: diary.occurredAt.toISOString(),
              path: `diaries/${diary.uuid}.enc`,
              byteLength: diary.contentByteLength,
              sha256: '0'.repeat(64),
              encryption: placeholderEncryption,
              images: (imagesByDiary.get(diary.id) ?? []).map((image) => ({
                uuid: image.uuid,
                mimeType:
                  image.mimeType as BackupManifest['diaries'][number]['images'][number]['mimeType'],
                path: `images/${image.uuid}.enc`,
                byteLength: image.byteLength,
                sha256: '0'.repeat(64),
                encryption: placeholderEncryption
              }))
            }))
          }
          // Pre-check and final validation share the same schema; the JSON and two reserved entries also count toward the total budget.
          BackupManifestSchema.parse(manifest)
          this.assertArchiveBudget(
            totalBytes,
            JSON.stringify(placeholderHeader),
            JSON.stringify(manifest)
          )
          // One budget for the entire backup, not a fresh allowance per image/diary.
          const imageBudget = createImageValidationBudget({ assertActive: guard })
          for (let index = 0; index < selected.length; index++) {
            guard?.()
            const metadata = selected[index]
            const diary = await this.diaries.findInNotebook(notebookId, metadata.id, {
              transaction
            })
            guard?.()
            if (!diary) throw new AppError('Diary not found.', 'DIARY_NOT_FOUND')
            const manifestDiary = manifest.diaries[index]
            const plaintext = decryptBytes(
              {
                ciphertext: diary.contentCiphertext,
                nonce: diary.contentNonce,
                tag: diary.contentTag
              },
              operationKey,
              diaryContentAad(notebook.uuid, diary.uuid, manifestDiary.occurredAt)
            )
            try {
              guard?.()
              if (plaintext.length !== metadata.contentByteLength)
                throw new AppError('Damaged diary content.', 'DIARY_DATA_DAMAGED')
              this.assertRestorableReferences(plaintext.toString('utf8'), manifestDiary.images)
              guard?.()
              const value = encryptBytes(
                plaintext,
                operationKey,
                backupDiaryAad(notebook.uuid, diary.uuid, manifestDiary.occurredAt)
              )
              const ciphertext = Buffer.from(value.ciphertext, 'base64')
              try {
                await writeFile(join(directory, `${diary.uuid}.diary`), ciphertext, {
                  flag: 'wx',
                  mode: 0o600
                })
                guard?.()
                manifestDiary.sha256 = sha256(ciphertext)
                manifestDiary.encryption = withoutCiphertext(value)
              } finally {
                ciphertext.fill(0)
              }
            } finally {
              plaintext.fill(0)
            }
            const imageMetadata = imagesByDiary.get(diary.id) ?? []
            for (let imageIndex = 0; imageIndex < imageMetadata.length; imageIndex++) {
              const image = await this.images.findById(imageMetadata[imageIndex].id, {
                transaction
              })
              guard?.()
              if (!image || image.diaryId !== diary.id)
                throw new AppError('Damaged diary image.', 'DIARY_DATA_DAMAGED')
              const bytes = decryptBytes(
                { ciphertext: image.ciphertext, nonce: image.nonce, tag: image.tag },
                operationKey,
                diaryImageAad(notebook.uuid, diary.uuid, image.uuid, image.mimeType)
              )
              try {
                guard?.()
                if (bytes.length !== image.byteLength)
                  throw new AppError('Damaged diary image.', 'DIARY_DATA_DAMAGED')
                const validated = await validateImageDataUrl(
                  `data:${image.mimeType};base64,${bytes.toString('base64')}`,
                  DIARY_IMAGE_MAX_BYTES,
                  imageBudget
                )
                try {
                  guard?.()
                } finally {
                  validated.bytes.fill(0)
                }
                guard?.()
                const value = encryptBytes(
                  bytes,
                  operationKey,
                  backupImageAad(notebook.uuid, diary.uuid, image.uuid, image.mimeType)
                )
                const ciphertext = Buffer.from(value.ciphertext, 'base64')
                try {
                  await writeFile(join(directory, `${image.uuid}.image`), ciphertext, {
                    flag: 'wx',
                    mode: 0o600
                  })
                  guard?.()
                  manifestDiary.images[imageIndex].sha256 = sha256(ciphertext)
                  manifestDiary.images[imageIndex].encryption = withoutCiphertext(value)
                } finally {
                  ciphertext.fill(0)
                }
              } finally {
                bytes.fill(0)
              }
            }
          }
          guard?.()
          // Re-validate the fully populated manifest, then encrypt it into the archive header.
          BackupManifestSchema.parse(manifest)
          const manifestJson = JSON.stringify(manifest)
          const headerJson = canonicalHeaderWithoutManifest(unsignedHeader)
          const manifestPlaintext = Buffer.from(manifestJson)
          try {
            guard?.()
            const value = encryptBytes(
              manifestPlaintext,
              operationKey,
              backupManifestAad(headerJson)
            )
            const header = BackupHeaderSchema.parse({
              ...unsignedHeader,
              manifest: withoutCiphertext(value)
            })
            const serializedHeader = JSON.stringify(header)
            this.assertArchiveBudget(totalBytes, serializedHeader, manifestJson)
            const manifestFile = join(directory, 'manifest.enc')
            const ciphertext = Buffer.from(value.ciphertext, 'base64')
            try {
              await writeFile(manifestFile, ciphertext, { flag: 'wx', mode: 0o600 })
            } finally {
              ciphertext.fill(0)
            }
            guard?.()
            return { manifest, headerJson: serializedHeader, manifestFile }
          } finally {
            manifestPlaintext.fill(0)
          }
        } catch (error) {
          // Map schema failures before the repository redacts unknown errors.
          if (error instanceof ZodError)
            throw new AppError('Stored diary backup metadata is damaged.', 'DIARY_DATA_DAMAGED')
          throw error
        }
      })
      guard?.()
      // Stream the staged ciphertext into the final ZIP archive.
      await this.writeZip(
        archivePath,
        directory,
        staged.headerJson,
        staged.manifestFile,
        staged.manifest,
        guard
      )
      guard?.()
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
      workDir = undefined
      guard?.()
      const previousPath = await this.replaceExportFile(archivePath, outputPath, guard)
      try {
        guard?.()
      } catch (error) {
        await rename(outputPath, archivePath)
        if (previousPath) await rename(previousPath, outputPath)
        throw error
      }
      // Do not yield after the final guard; cleanup failure only leaves an encrypted old backup copy behind.
      if (previousPath) {
        try {
          rmSync(previousPath, { force: true })
        } catch {
          /* Keep the old ciphertext copy. */
        }
      }
      archivePath = undefined
      return { canceled: false, diaryCount: staged.manifest.diaries.length }
    } catch (error) {
      if (error instanceof ZodError)
        throw new AppError('Stored diary backup metadata is damaged.', 'DIARY_DATA_DAMAGED')
      throw error
    } finally {
      operationKey.fill(0)
      if (archivePath) await rm(archivePath, { force: true }).catch(() => undefined)
      if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async importBackup(
    userId: number,
    password: string,
    archivePath: string,
    guard?: () => void
  ): Promise<{ result: BackupImportResultDTO; dataKey: Buffer }> {
    guard?.()
    const temporaryKey = createDataKey()
    const operationId = randomUUID()
    let workDir: string | undefined
    let sourceKey: Buffer | undefined
    let targetKey: Buffer | undefined
    let returnedKey: Buffer | undefined
    try {
      workDir = await mkdtemp(join(tmpdir(), 'myapp-diary-import-'))
      guard?.()
      await chmod(workDir, 0o700)
      guard?.()
      // Extract every entry into encrypted temporary files before touching the database.
      const entries = await this.extractArchive(
        archivePath,
        workDir,
        temporaryKey,
        operationId,
        guard
      )
      guard?.()
      const headerEntry = entries.get(BACKUP_HEADER_ENTRY)
      const manifestEntry = entries.get(BACKUP_MANIFEST_ENTRY)
      if (
        !headerEntry ||
        !manifestEntry ||
        headerEntry.size > BACKUP_MAX_HEADER_BYTES ||
        manifestEntry.size > BACKUP_MAX_MANIFEST_BYTES
      )
        throw new AppError('Invalid diary backup.', 'INVALID_BACKUP')
      const headerBytes = await this.readTemporaryEntry(headerEntry, temporaryKey, guard)
      let header: BackupHeader
      try {
        header = BackupHeaderSchema.parse(JSON.parse(headerBytes.toString('utf8')))
      } finally {
        headerBytes.fill(0)
      }
      guard?.()
      const { manifest: manifestMetadata, ...unsignedHeader } = header
      const headerJson = canonicalHeaderWithoutManifest(unsignedHeader)
      // Recover the source key, then decrypt and parse the manifest to learn the expected entries.
      sourceKey = await unwrapDataKey(password, header.sourceNotebookUuid, headerEnvelope(header))
      guard?.()
      const encryptedManifest = await this.readTemporaryEntry(manifestEntry, temporaryKey, guard)
      let manifest: BackupManifest
      try {
        const plaintext = decryptBytes(
          { ciphertext: encryptedManifest.toString('base64'), ...manifestMetadata },
          sourceKey,
          backupManifestAad(headerJson)
        )
        try {
          manifest = BackupManifestSchema.parse(JSON.parse(plaintext.toString('utf8')))
        } finally {
          plaintext.fill(0)
        }
      } finally {
        encryptedManifest.fill(0)
      }
      guard?.()
      const expectedPaths = new Set([BACKUP_HEADER_ENTRY, BACKUP_MANIFEST_ENTRY])
      for (const diary of manifest.diaries) {
        expectedPaths.add(diary.path)
        for (const image of diary.images) expectedPaths.add(image.path)
      }
      if (
        entries.size !== expectedPaths.size ||
        [...entries.keys()].some((path) => !expectedPaths.has(path))
      )
        throw new AppError('Backup contains unexpected entries.', 'INVALID_BACKUP')
      // Reject unexpected entries, then decrypt, hash-check and stage every diary/image.
      const validated = await this.validateEntries(
        header.sourceNotebookUuid,
        manifest,
        entries,
        sourceKey,
        workDir,
        temporaryKey,
        operationId,
        guard
      )
      guard?.()
      // Persist the imported notebook and its diaries under a fresh key in one transaction.
      targetKey = createDataKey()
      const ownedTargetKey = targetKey
      const created = await this.notebookRepository.transaction(async (transaction) => {
        registerTransactionGuard(transaction, guard)
        guard?.()
        const name = await this.availableImportedName(
          userId,
          manifest.notebookName,
          transaction,
          guard
        )
        guard?.()
        const uuid = randomUUID()
        const envelope = await wrapDataKey(password, uuid, ownedTargetKey)
        guard?.()
        const notebook = await this.notebookRepository.create(
          { uuid, userId, name, ...envelope },
          { transaction }
        )
        guard?.()
        for (const diary of validated) {
          const markdownBytes = await this.readTemporaryEntry(diary.markdown, temporaryKey, guard)
          let markdown = markdownBytes.toString('utf8')
          markdownBytes.fill(0)
          const imageInputs: DiaryImageInputDTO[] = []
          try {
            const replacements = new Map<string, string>()
            for (const image of diary.images) {
              const bytes = await this.readTemporaryEntry(image.entry, temporaryKey, guard)
              try {
                guard?.()
                const reference = `draft-image://${image.uuid}`
                replacements.set(`diary-image://${image.uuid}`, reference)
                imageInputs.push({
                  reference,
                  mimeType: image.mimeType as DiaryImageInputDTO['mimeType'],
                  dataUrl: `data:${image.mimeType};base64,${bytes.toString('base64')}`
                })
              } finally {
                bytes.fill(0)
              }
            }
            markdown = replaceDiaryImageReferences(markdown, replacements)
            guard?.()
            // DiaryService's nested write transaction reuses CLS and must not commit early.
            await this.diaryService.create(
              userId,
              {
                notebookId: notebook.id,
                occurredAt: diary.occurredAt,
                markdown,
                images: imageInputs
              },
              ownedTargetKey,
              guard
            )
            guard?.()
          } finally {
            // eslint-disable-next-line no-useless-assignment
            markdown = ''
            for (const image of imageInputs) image.dataUrl = ''
          }
        }
        // The cleanup wait point is also placed before commit, so a failure during it still rolls back the whole import.
        await rm(workDir!, { recursive: true, force: true }).catch(() => undefined)
        workDir = undefined
        sourceKey?.fill(0)
        temporaryKey.fill(0)
        guard?.()
        return this.notebooks.toSummary(notebook)
      })
      guard?.()
      returnedKey = Buffer.from(ownedTargetKey)
      const result = {
        result: { canceled: false, notebook: created, diaryCount: validated.length },
        dataKey: returnedKey
      }
      guard?.()
      return result
    } catch (error) {
      returnedKey?.fill(0)
      if (error instanceof AppError && error.code === 'INVALID_NOTEBOOK_PASSWORD') throw error
      if (
        error instanceof AppError &&
        !['INVALID_BACKUP', 'DIARY_DATA_DAMAGED', 'INVALID_INPUT', 'DIARY_TOO_LARGE'].includes(
          error.code
        )
      )
        throw error
      throw new AppError('Invalid or damaged diary backup.', 'INVALID_BACKUP')
    } finally {
      sourceKey?.fill(0)
      temporaryKey.fill(0)
      targetKey?.fill(0)
      if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private assertArchiveBudget(contentBytes: number, header: string, manifest: string): void {
    const headerBytes = Buffer.byteLength(header, 'utf8')
    const manifestBytes = Buffer.byteLength(manifest, 'utf8')
    if (
      headerBytes > BACKUP_MAX_HEADER_BYTES ||
      manifestBytes > BACKUP_MAX_MANIFEST_BYTES ||
      headerBytes + manifestBytes + contentBytes > BACKUP_MAX_UNCOMPRESSED_BYTES
    )
      throw new AppError('Diary backup is too large.', 'DIARY_TOO_LARGE')
  }

  private assertImageMetadata(images: DiaryImageMetadata[]): void {
    let bytes = 0
    if (images.length > DIARY_MAX_IMAGES)
      throw new AppError('Stored diary has too many images.', 'DIARY_TOO_LARGE')
    for (const image of images) {
      if (
        !Number.isSafeInteger(image.byteLength) ||
        image.byteLength <= 0 ||
        image.byteLength > DIARY_IMAGE_MAX_BYTES ||
        image.byteLength > BACKUP_MAX_ENTRY_BYTES ||
        image.ciphertextByteLength !== image.byteLength
      )
        throw new AppError('Stored image exceeds backup limits or is damaged.', 'DIARY_TOO_LARGE')
      bytes += image.byteLength
    }
    if (bytes > DIARY_IMAGES_MAX_BYTES)
      throw new AppError('Stored diary images exceed backup limits.', 'DIARY_TOO_LARGE')
  }

  private assertRestorableReferences(markdown: string, images: Array<{ uuid: string }>): void {
    const owned = new Set(images.map((image) => `diary-image://${image.uuid}`))
    const references = new Set(scanDiaryImageReferences(markdown).map((token) => token.reference))
    if (
      owned.size !== references.size ||
      [...references].some((reference) => !owned.has(reference))
    )
      throw new AppError('Diary image references do not match stored images.', 'INVALID_BACKUP')
  }

  private async assertSafeExportPath(outputPath: string): Promise<void> {
    try {
      const metadata = await lstat(outputPath)
      if (!metadata.isFile() || metadata.isSymbolicLink())
        throw new AppError('Unsafe backup destination.', 'INVALID_INPUT')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }

  private async replaceExportFile(
    archivePath: string,
    outputPath: string,
    guard?: () => void
  ): Promise<string | undefined> {
    const previousPath = join(
      dirname(outputPath),
      `.${basename(outputPath)}.${randomUUID()}.previous`
    )
    let movedPrevious = false
    let installed = false
    try {
      try {
        const metadata = await lstat(outputPath)
        guard?.()
        if (!metadata.isFile() || metadata.isSymbolicLink())
          throw new AppError('Unsafe backup destination.', 'INVALID_INPUT')
        await rename(outputPath, previousPath)
        movedPrevious = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      guard?.()
      await rename(archivePath, outputPath)
      installed = true
      guard?.()
    } catch (error) {
      if (installed) await rename(outputPath, archivePath)
      if (movedPrevious) await rename(previousPath, outputPath)
      throw error
    }
    return movedPrevious ? previousPath : undefined
  }

  private async writeZip(
    outputPath: string,
    workDir: string,
    headerJson: string,
    manifestFile: string,
    manifest: BackupManifest,
    guard?: () => void
  ): Promise<void> {
    const zip = new yazl.ZipFile()
    // yazl implements this as PassThrough; its public types use ReadableStream.
    const output = zip.outputStream as Readable
    const inputs = new Set<Readable>()
    const pending = new Set<Promise<void>>()
    const fail = (error: unknown): void => {
      output.destroy(types.isNativeError(error) ? error : new Error('Backup ZIP failed.'))
    }
    zip.on('error', fail)
    output.once('close', () => {
      for (const input of inputs) input.destroy()
    })
    output.on('data', () => {
      try {
        guard?.()
      } catch (error) {
        fail(error)
      }
    })
    const completion = pipeline(output, createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }))
    void completion.catch(() => undefined)
    const addStagedFile = (path: string, name: string, size: number): void => {
      // Own the readers so cancellation waits for every file handle to close.
      // All staged ciphertext has the same byte length as its plaintext.
      zip.addReadStreamLazy(name, { size, compress: false }, (callback) => {
        try {
          guard?.()
          if (output.destroyed) throw new Error('Backup ZIP closed.')
          const input = createReadStream(path)
          inputs.add(input)
          input.once('error', fail)
          input.once('close', () => inputs.delete(input))
          const done = finished(input, { cleanup: true }).catch(() => undefined)
          pending.add(done)
          void done.then(() => pending.delete(done))
          callback(null, input)
        } catch (error) {
          callback(types.isNativeError(error) ? error : new Error('Backup ZIP failed.'), undefined!)
        }
      })
    }
    try {
      guard?.()
      // Do not compress ciphertext; exports stay within import ratio limits.
      zip.addBuffer(Buffer.from(headerJson, 'utf8'), BACKUP_HEADER_ENTRY, { compress: false })
      addStagedFile(
        manifestFile,
        BACKUP_MANIFEST_ENTRY,
        Buffer.byteLength(JSON.stringify(manifest))
      )
      for (const diary of manifest.diaries) {
        addStagedFile(join(workDir, `${diary.uuid}.diary`), diary.path, diary.byteLength)
        for (const image of diary.images)
          addStagedFile(join(workDir, `${image.uuid}.image`), image.path, image.byteLength)
      }
      zip.end()
      await completion
    } catch (error) {
      fail(error)
      await completion.catch(() => undefined)
      throw error
    } finally {
      for (const input of inputs) input.destroy()
      await Promise.allSettled(pending)
    }
  }

  /** The ZIP extraction stream is also encrypted, including the public header; only temporary ciphertext exists on disk. */
  private async extractArchive(
    archivePath: string,
    workDir: string,
    temporaryKey: Buffer,
    operationId: string,
    guard?: () => void
  ): Promise<Map<string, ExtractedEntry>> {
    const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
      yauzl.open(
        archivePath,
        { lazyEntries: true, autoClose: true, decodeStrings: true },
        (error, value) => {
          if (error || !value) reject(error ?? new Error('Unable to open ZIP'))
          else resolve(value)
        }
      )
    })
    const entries = new Map<string, ExtractedEntry>()
    let totalBytes = 0
    let sequence = 0
    let stopped = false
    let failure: unknown
    let activeStream: Readable | undefined
    let activeEntry: Promise<void> | undefined
    const closed = new Promise<void>((resolve) => zip.once('close', resolve))
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = (error: unknown): void => {
          if (stopped) return
          stopped = true
          failure = error
          activeStream?.destroy()
          zip.close()
          reject(error)
        }
        zip.on('error', fail)
        zip.once('end', () => {
          if (stopped) return
          stopped = true
          resolve()
        })
        zip.on('entry', (entry: yauzl.Entry) => {
          if (stopped) return
          const job = (async () => {
            guard?.()
            const name = entry.fileName
            const unsafeOriginalPath = Boolean(
              (entry as yauzl.Entry & { __unsafeOriginalFileName?: string })
                .__unsafeOriginalFileName
            )
            const mode = (entry.externalFileAttributes >>> 16) & 0xffff
            const fileType = mode & 0xf000
            // Reject path traversal, unsafe names, and encrypted/oversized/over-compressed entries before streaming.
            const invalidPath =
              !name ||
              name.includes('\\') ||
              name.startsWith('/') ||
              /^[A-Za-z]:/.test(name) ||
              name.split('/').some((part) => part === '' || part === '.' || part === '..')
            const ratio =
              entry.compressedSize === 0
                ? entry.uncompressedSize
                : entry.uncompressedSize / entry.compressedSize
            const maxBytes =
              name === BACKUP_HEADER_ENTRY
                ? BACKUP_MAX_HEADER_BYTES
                : name === BACKUP_MANIFEST_ENTRY
                  ? BACKUP_MAX_MANIFEST_BYTES
                  : BACKUP_MAX_ENTRY_BYTES
            if (
              invalidPath ||
              unsafeOriginalPath ||
              name.endsWith('/') ||
              entries.has(name) ||
              entries.size >= BACKUP_MAX_ENTRIES ||
              (entry.generalPurposeBitFlag & 1) !== 0 ||
              (fileType !== 0 && fileType !== 0x8000) ||
              entry.uncompressedSize > maxBytes ||
              ratio > BACKUP_MAX_COMPRESSION_RATIO
            )
              throw new AppError('Unsafe diary backup archive.', 'INVALID_BACKUP')
            totalBytes += entry.uncompressedSize
            if (totalBytes > BACKUP_MAX_UNCOMPRESSED_BYTES)
              throw new AppError('Diary backup is too large.', 'INVALID_BACKUP')
            const outputPath = join(workDir, `entry-${sequence++}`)
            const hasher = createHash('sha256')
            let extractedBytes = 0
            const stream = await new Promise<Readable>((streamResolve, streamReject) => {
              zip.openReadStream(entry, (error, value) => {
                if (error || !value) streamReject(error ?? new Error('Unable to read ZIP entry'))
                else streamResolve(value)
              })
            })
            activeStream = stream
            if (stopped) {
              stream.destroy()
              throw failure ?? new AppError('Backup extraction canceled.', 'INVALID_BACKUP')
            }
            try {
              // Re-encrypt the extracted bytes under the temporary key while streaming to disk.
              const nonce = randomBytes(12)
              const aad = `myapp:backup-temporary:v1:${operationId}:extracted:${name}`
              const cipher = createCipheriv('aes-256-gcm', temporaryKey, nonce)
              cipher.setAAD(Buffer.from(aad))
              stream.on('data', (chunk: Buffer) => {
                extractedBytes += chunk.length
                hasher.update(chunk)
                try {
                  guard?.()
                  if (extractedBytes > entry.uncompressedSize || extractedBytes > maxBytes)
                    throw new Error('ZIP entry exceeded declared size')
                } catch (error) {
                  stream.destroy(error as Error)
                }
              })
              await pipeline(
                stream,
                cipher,
                createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
              )
              guard?.()
              if (stopped)
                throw failure ?? new AppError('Backup extraction canceled.', 'INVALID_BACKUP')
              if (extractedBytes !== entry.uncompressedSize)
                throw new AppError('Damaged diary backup entry.', 'INVALID_BACKUP')
              hasher.digest()
              entries.set(name, {
                path: outputPath,
                size: extractedBytes,
                aad,
                encryption: {
                  nonce: nonce.toString('base64'),
                  tag: cipher.getAuthTag().toString('base64')
                }
              })
            } finally {
              stream.destroy()
              if (activeStream === stream) activeStream = undefined
            }
          })()
          activeEntry = job
          void job.then(() => {
            if (activeEntry === job) activeEntry = undefined
            if (!stopped) {
              try {
                zip.readEntry()
              } catch (error) {
                fail(error)
              }
            }
          }, fail)
        })
        zip.readEntry()
      })
      guard?.()
      return entries
    } finally {
      // Do not clear the temporary key/remove the directory while a late
      // openReadStream callback or an active encrypted pipeline is still alive.
      stopped = true
      activeStream?.destroy()
      zip.close()
      await activeEntry?.catch(() => undefined)
      await closed
    }
  }

  private async readTemporaryEntry(
    entry: TemporaryEntry,
    temporaryKey: Buffer,
    guard?: () => void
  ): Promise<Buffer> {
    const ciphertext = await readFile(entry.path)
    let plaintext: Buffer | undefined
    let pending: Buffer | undefined
    let final: Buffer | undefined
    try {
      guard?.()
      const decipher = createDecipheriv(
        'aes-256-gcm',
        temporaryKey,
        Buffer.from(entry.encryption.nonce, 'base64')
      )
      decipher.setAAD(Buffer.from(entry.aad))
      decipher.setAuthTag(Buffer.from(entry.encryption.tag, 'base64'))
      pending = decipher.update(ciphertext)
      final = decipher.final()
      plaintext = Buffer.concat([pending, final])
      guard?.()
      return plaintext
    } catch (error) {
      plaintext?.fill(0)
      throw error
    } finally {
      pending?.fill(0)
      final?.fill(0)
      ciphertext.fill(0)
    }
  }

  private async stagePlaintext(
    plaintext: Buffer,
    workDir: string,
    temporaryKey: Buffer,
    operationId: string,
    entryPath: string,
    sequence: number,
    guard?: () => void
  ): Promise<TemporaryEntry> {
    guard?.()
    const aad = `myapp:backup-temporary:v1:${operationId}:validated:${sequence}:${entryPath}`
    const value = encryptBytes(plaintext, temporaryKey, aad)
    const ciphertext = Buffer.from(value.ciphertext, 'base64')
    try {
      const path = join(workDir, `validated-${sequence}`)
      await writeFile(path, ciphertext, { flag: 'wx', mode: 0o600 })
      guard?.()
      return { path, aad, encryption: withoutCiphertext(value) }
    } finally {
      ciphertext.fill(0)
    }
  }

  private async validateEntries(
    sourceNotebookUuid: string,
    manifest: BackupManifest,
    entries: Map<string, ExtractedEntry>,
    sourceKey: Buffer,
    workDir: string,
    temporaryKey: Buffer,
    operationId: string,
    guard?: () => void
  ): Promise<ValidatedDiary[]> {
    const result: ValidatedDiary[] = []
    const imageBudget = createImageValidationBudget({ assertActive: guard })
    let sequence = 0
    for (const diary of manifest.diaries) {
      guard?.()
      if (
        diary.byteLength > DIARY_MARKDOWN_MAX_BYTES ||
        diary.images.length > DIARY_MAX_IMAGES ||
        diary.images.some((image) => image.byteLength > DIARY_IMAGE_MAX_BYTES) ||
        diary.images.reduce((sum, image) => sum + image.byteLength, 0) > DIARY_IMAGES_MAX_BYTES
      )
        throw new AppError('Diary exceeds supported limits.', 'INVALID_BACKUP')
      const entry = entries.get(diary.path)
      if (!entry || entry.size !== diary.byteLength)
        throw new AppError('Damaged diary backup entry.', 'INVALID_BACKUP')
      const ciphertext = await this.readTemporaryEntry(entry, temporaryKey, guard)
      let plaintext: Buffer | undefined
      let markdownEntry: TemporaryEntry
      try {
        if (ciphertext.length !== diary.byteLength || sha256(ciphertext) !== diary.sha256)
          throw new AppError('Damaged diary backup entry.', 'INVALID_BACKUP')
        plaintext = decryptBytes(
          { ciphertext: ciphertext.toString('base64'), ...diary.encryption },
          sourceKey,
          backupDiaryAad(sourceNotebookUuid, diary.uuid, diary.occurredAt)
        )
        guard?.()
        this.assertRestorableReferences(plaintext.toString('utf8'), diary.images)
        markdownEntry = await this.stagePlaintext(
          plaintext,
          workDir,
          temporaryKey,
          operationId,
          diary.path,
          sequence++,
          guard
        )
      } finally {
        ciphertext.fill(0)
        plaintext?.fill(0)
      }
      const validatedDiary: ValidatedDiary = {
        occurredAt: diary.occurredAt,
        markdown: markdownEntry,
        images: []
      }
      for (const image of diary.images) {
        guard?.()
        const imageEntry = entries.get(image.path)
        if (!imageEntry || imageEntry.size !== image.byteLength)
          throw new AppError('Damaged diary backup image.', 'INVALID_BACKUP')
        const imageCiphertext = await this.readTemporaryEntry(imageEntry, temporaryKey, guard)
        let bytes: Buffer | undefined
        try {
          if (
            imageCiphertext.length !== image.byteLength ||
            sha256(imageCiphertext) !== image.sha256
          )
            throw new AppError('Damaged diary backup image.', 'INVALID_BACKUP')
          bytes = decryptBytes(
            { ciphertext: imageCiphertext.toString('base64'), ...image.encryption },
            sourceKey,
            backupImageAad(sourceNotebookUuid, diary.uuid, image.uuid, image.mimeType)
          )
          guard?.()
          const validated = await validateImageDataUrl(
            `data:${image.mimeType};base64,${bytes.toString('base64')}`,
            DIARY_IMAGE_MAX_BYTES,
            imageBudget
          )
          try {
            guard?.()
          } finally {
            validated.bytes.fill(0)
          }
          const staged = await this.stagePlaintext(
            bytes,
            workDir,
            temporaryKey,
            operationId,
            image.path,
            sequence++,
            guard
          )
          guard?.()
          validatedDiary.images.push({ uuid: image.uuid, mimeType: image.mimeType, entry: staged })
        } finally {
          imageCiphertext.fill(0)
          bytes?.fill(0)
        }
      }
      result.push(validatedDiary)
    }
    guard?.()
    return result
  }

  private async availableImportedName(
    userId: number,
    requested: string,
    transaction?: Transaction,
    guard?: () => void
  ): Promise<string> {
    guard?.()
    const options = { transaction }
    const existing = await this.notebookRepository.findName(userId, requested, options)
    guard?.()
    if (!existing) return requested
    for (let suffix = 2; suffix < 10_000; suffix++) {
      const marker = `（导入 ${suffix}）`
      const candidate = `${requested.slice(0, Math.max(1, 80 - marker.length))}${marker}`
      const found = await this.notebookRepository.findName(userId, candidate, options)
      guard?.()
      if (!found) return candidate
    }
    throw new AppError('Unable to choose an imported notebook name.', 'DATA_EXISTS')
  }
}

export default DiaryBackupService
