import 'reflect-metadata'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as yauzl from 'yauzl'
import * as yazl from 'yazl'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Sequelize } from 'sequelize-typescript'

vi.mock('../../../src/main/logger', () => ({ default: { error: vi.fn() } }))
import { User } from '../../../src/main/database/models/user.model'
import { Notebook } from '../../../src/main/database/models/notebook.model'
import { Diary } from '../../../src/main/database/models/diary.model'
import { DiaryImage } from '../../../src/main/database/models/diary-image.model'
import UserRepository from '../../../src/main/database/repositories/UserRepository'
import NotebookRepository from '../../../src/main/database/repositories/NotebookRepository'
import DiaryRepository from '../../../src/main/database/repositories/DiaryRepository'
import DiaryImageRepository from '../../../src/main/database/repositories/DiaryImageRepository'
import NotebookService from '../../../src/main/services/NotebookService'
import DiaryService from '../../../src/main/services/DiaryService'
import DiaryBackupService from '../../../src/main/services/DiaryBackupService'
import { AppError } from '../../../src/main/errors'
import * as imageValidation from '../../../src/main/services/image-validation'
import {
  NOTEBOOK_CRYPTO_VERSION,
  NOTEBOOK_KDF_ALGORITHM,
  encryptBytes
} from '../../../src/main/crypto/notebook-crypto'
import {
  BACKUP_MAX_ENTRIES,
  DIARY_IMAGE_MAX_BYTES,
  DIARY_MARKDOWN_MAX_BYTES
} from '../../../src/common/diary-limits'
import {
  BackupManifestSchema,
  BackupUnsignedHeaderSchema,
  DIARY_BACKUP_FORMAT,
  backupDiaryAad,
  backupManifestAad,
  canonicalHeaderWithoutManifest,
  sha256,
  withoutCiphertext,
  type BackupManifest
} from '../../../src/main/backup/format'

const pngDataUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const pngBytes = Buffer.from(pngDataUrl.split(',')[1], 'base64')
const secret = 'PRIVATE-DIARY-PLAINTEXT-MUST-NOT-TOUCH-DISK-2026'
const occurredAt = '2026-11-20T08:00:00.000Z'

describe('备份安全预算、加密暂存与取消', () => {
  let database: Sequelize
  let workDir: string
  let archivePath: string
  let userId: number
  let notebookId: number
  let key: Buffer
  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'myapp-backup-security-'))
    archivePath = join(workDir, 'source.zip')
    database = new Sequelize({
      dialect: 'sqlite',
      storage: ':memory:',
      models: [User, Notebook, Diary, DiaryImage],
      logging: false
    })
    await database.sync({ force: true })
    const user = await new UserRepository().create({
      name: 'Backup test',
      email: 'backup-security@example.com',
      password: 'test-password'
    })
    userId = user.id
    const created = await new NotebookService().create(userId, 'Backup journal', 'backup-password')
    notebookId = created.dto.id
    key = created.dataKey
    const service = new DiaryService()
    await service.create(
      userId,
      {
        notebookId,
        occurredAt,
        markdown: `${secret}\n![x](draft-image://image)`,
        images: [{ reference: 'draft-image://image', mimeType: 'image/png', dataUrl: pngDataUrl }]
      },
      key
    )
    await service.create(userId, { notebookId, occurredAt, markdown: '', images: [] }, key)
    await new DiaryBackupService().exportBackup(userId, notebookId, undefined, key, archivePath)
  })
  afterAll(async () => {
    key?.fill(0)
    pngBytes.fill(0)
    await database?.close()
    if (workDir) await rm(workDir, { recursive: true, force: true })
  })

  it('空正文 byteLength=0 合法，图片仍必须 positive', () => {
    const uuid = randomUUID()
    const manifest = {
      format: DIARY_BACKUP_FORMAT,
      version: 1,
      notebookName: 'Empty',
      exportedAt: occurredAt,
      diaries: [
        {
          uuid,
          occurredAt,
          path: `diaries/${uuid}.enc`,
          byteLength: 0,
          sha256: '0'.repeat(64),
          encryption: {
            nonce: Buffer.alloc(12).toString('base64'),
            tag: Buffer.alloc(16).toString('base64')
          },
          images: []
        }
      ]
    }
    expect(BackupManifestSchema.safeParse(manifest).success).toBe(true)
    const imageUuid = randomUUID()
    expect(
      BackupManifestSchema.safeParse({
        ...manifest,
        diaries: [
          {
            ...manifest.diaries[0],
            images: [
              {
                uuid: imageUuid,
                mimeType: 'image/png',
                path: `images/${imageUuid}.enc`,
                byteLength: 0,
                sha256: '0'.repeat(64),
                encryption: manifest.diaries[0].encryption
              }
            ]
          }
        ]
      }).success
    ).toBe(false)
  })

  it('空正文日记可导出并恢复', async () => {
    const imported = await new DiaryBackupService().importBackup(
      userId,
      'backup-password',
      archivePath
    )
    try {
      expect(imported.result.diaryCount).toBe(2)
      const service = new DiaryService()
      const summaries = await service.list(userId, imported.result.notebook!.id, imported.dataKey)
      const markdown: string[] = []
      for (const entry of summaries)
        markdown.push(
          (await service.get(userId, entry.notebookId, entry.id, imported.dataKey)).markdown
        )
      expect(markdown).toContain('')
      expect(markdown.some((text) => text.includes(secret))).toBe(true)
    } finally {
      imported.dataKey.fill(0)
    }
  })

  it('canonical header 不依赖插入顺序且仍拒绝版本、KDF 和未知字段', async () => {
    const notebooks = new NotebookService()
    const notebook = await notebooks.requireOwned(userId, notebookId)
    const envelope = notebooks.envelope(notebook)
    const legacyOrder = {
      format: DIARY_BACKUP_FORMAT,
      version: 1 as const,
      sourceNotebookUuid: notebook.uuid,
      sourceUserId: userId,
      cryptoVersion: NOTEBOOK_CRYPTO_VERSION,
      kdfAlgorithm: NOTEBOOK_KDF_ALGORITHM,
      kdfSalt: envelope.kdfSalt,
      kdfN: envelope.kdfN,
      kdfR: envelope.kdfR,
      kdfP: envelope.kdfP,
      wrappedKey: envelope.wrappedKey,
      wrappedKeyNonce: envelope.wrappedKeyNonce,
      wrappedKeyTag: envelope.wrappedKeyTag
    } as const
    const reversed = Object.fromEntries(Object.entries(legacyOrder).reverse()) as typeof legacyOrder
    expect(canonicalHeaderWithoutManifest(reversed)).toBe(JSON.stringify(legacyOrder))
    expect(BackupUnsignedHeaderSchema.safeParse({ ...legacyOrder, version: 2 }).success).toBe(false)
    expect(BackupUnsignedHeaderSchema.safeParse({ ...legacyOrder, cryptoVersion: 2 }).success).toBe(
      false
    )
    expect(
      BackupUnsignedHeaderSchema.safeParse({ ...legacyOrder, kdfAlgorithm: 'pbkdf2' }).success
    ).toBe(false)
    expect(BackupUnsignedHeaderSchema.safeParse({ ...legacyOrder, kdfN: 3 }).success).toBe(false)
    expect(BackupUnsignedHeaderSchema.safeParse({ ...legacyOrder, extra: true }).success).toBe(
      false
    )
  })

  it('兼容独立按旧版本 1 字段顺序加密的归档，包括可选 sourceUserId 缺省', async () => {
    const notebooks = new NotebookService()
    const notebook = await notebooks.requireOwned(userId, notebookId)
    const envelope = notebooks.envelope(notebook)
    for (const withSourceUser of [true, false]) {
      // Deliberately do not use the new canonical helper to write this fixture.
      const oldUnsigned = {
        format: DIARY_BACKUP_FORMAT,
        version: 1,
        sourceNotebookUuid: notebook.uuid,
        sourceUserId: withSourceUser ? userId : undefined,
        cryptoVersion: NOTEBOOK_CRYPTO_VERSION,
        kdfAlgorithm: NOTEBOOK_KDF_ALGORITHM,
        kdfSalt: envelope.kdfSalt,
        kdfN: envelope.kdfN,
        kdfR: envelope.kdfR,
        kdfP: envelope.kdfP,
        wrappedKey: envelope.wrappedKey,
        wrappedKeyNonce: envelope.wrappedKeyNonce,
        wrappedKeyTag: envelope.wrappedKeyTag
      }
      const diaryUuid = randomUUID()
      const empty = Buffer.alloc(0)
      const encryptedDiary = encryptBytes(
        empty,
        key,
        backupDiaryAad(notebook.uuid, diaryUuid, occurredAt)
      )
      const diaryCiphertext = Buffer.from(encryptedDiary.ciphertext, 'base64')
      const manifest: BackupManifest = {
        format: DIARY_BACKUP_FORMAT,
        version: 1,
        notebookName: 'Legacy backup',
        exportedAt: occurredAt,
        diaries: [
          {
            uuid: diaryUuid,
            occurredAt,
            path: `diaries/${diaryUuid}.enc`,
            byteLength: 0,
            sha256: sha256(diaryCiphertext),
            encryption: withoutCiphertext(encryptedDiary),
            images: []
          }
        ]
      }
      const manifestPlaintext = Buffer.from(JSON.stringify(manifest))
      const encryptedManifest = encryptBytes(
        manifestPlaintext,
        key,
        backupManifestAad(JSON.stringify(oldUnsigned))
      )
      manifestPlaintext.fill(0)
      const manifestCiphertext = Buffer.from(encryptedManifest.ciphertext, 'base64')
      const header = { ...oldUnsigned, manifest: withoutCiphertext(encryptedManifest) }
      // Reordered JSON is allowed: AAD must still use the fixed version-1 order.
      const reorderedHeader = Object.fromEntries(Object.entries(header).reverse())
      const legacyPath = join(workDir, `legacy-${withSourceUser}.zip`)
      const zip = new yazl.ZipFile()
      const { createWriteStream } = await import('node:fs')
      const output = zip.outputStream as Readable
      const complete = pipeline(output, createWriteStream(legacyPath, { flags: 'wx' }))
      void complete.catch(() => undefined)
      try {
        zip.addBuffer(Buffer.from(JSON.stringify(reorderedHeader)), 'header.json', {
          compress: false
        })
        zip.addBuffer(manifestCiphertext, 'manifest.enc', { compress: false })
        zip.addBuffer(diaryCiphertext, manifest.diaries[0].path, { compress: false })
        zip.end()
        await complete
        const imported = await new DiaryBackupService().importBackup(
          userId,
          'backup-password',
          legacyPath
        )
        try {
          expect(imported.result.diaryCount).toBe(1)
          const diaries = await new DiaryService().list(
            userId,
            imported.result.notebook!.id,
            imported.dataKey
          )
          expect(
            (
              await new DiaryService().get(
                userId,
                imported.result.notebook!.id,
                diaries[0].id,
                imported.dataKey
              )
            ).markdown
          ).toBe('')
        } finally {
          imported.dataKey.fill(0)
        }
      } finally {
        output.destroy()
        await complete.catch(() => undefined)
        manifestCiphertext.fill(0)
        diaryCiphertext.fill(0)
      }
    }
  })

  it('单次备份的图片预算跨日记共享，导出保留旧目标且导入不写入', async () => {
    const created = await new NotebookService().create(
      userId,
      'Image budget backup',
      'backup-password'
    )
    const backups = new DiaryBackupService()
    const service = new DiaryService()
    const normalArchive = join(workDir, 'image-budget-source.zip')
    const outputPath = join(workDir, 'image-budget-existing.zip')
    const previous = Buffer.from('previous backup must survive image budget rejection')
    try {
      for (let index = 0; index < 2; index++) {
        await service.create(
          userId,
          {
            notebookId: created.dto.id,
            occurredAt,
            markdown: '![x](draft-image://image)',
            images: [
              { reference: 'draft-image://image', mimeType: 'image/png', dataUrl: pngDataUrl }
            ]
          },
          created.dataKey
        )
      }
      await backups.exportBackup(userId, created.dto.id, undefined, created.dataKey, normalArchive)
      await writeFile(outputPath, previous, { flag: 'wx' })
      const original = imageValidation.createImageValidationBudget
      const budgets = vi
        .spyOn(imageValidation, 'createImageValidationBudget')
        .mockImplementation((options) => original({ ...options, maxPixels: 1 }))
      try {
        await expect(
          backups.exportBackup(userId, created.dto.id, undefined, created.dataKey, outputPath)
        ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
        expect(budgets).toHaveBeenCalledTimes(1)
        expect(await readFile(outputPath)).toEqual(previous)
        budgets.mockClear()
        const before = await Notebook.count()
        await expect(
          backups.importBackup(userId, 'backup-password', normalArchive)
        ).rejects.toMatchObject({ code: 'INVALID_BACKUP' })
        expect(budgets).toHaveBeenCalledTimes(1)
        expect(await Notebook.count()).toBe(before)
      } finally {
        budgets.mockRestore()
      }
    } finally {
      created.dataKey.fill(0)
    }
  })

  it('ZIP 本体错误会拒绝输出 pipeline、关闭句柄且不替换旧目标', async () => {
    const error = new Error('Synthetic ZIP producer error')
    const outputPath = join(workDir, 'existing-zip-error.zip')
    const previous = Buffer.from('previous backup must survive ZIP producer error')
    await writeFile(outputPath, previous, { flag: 'wx' })
    const addBuffer = vi.spyOn(yazl.ZipFile.prototype, 'addBuffer').mockImplementation(function (
      this: yazl.ZipFile
    ) {
      this.emit('error', error)
    })
    try {
      await expect(
        new DiaryBackupService().exportBackup(userId, notebookId, undefined, key, outputPath)
      ).rejects.toBe(error)
      expect(await readFile(outputPath)).toEqual(previous)
      expect(
        (await readdir(workDir)).some((name) => name.startsWith('.existing-zip-error.zip.'))
      ).toBe(false)
    } finally {
      addBuffer.mockRestore()
    }
  })

  it('ZIP 源文件读取失败会等待关闭并清理自己的未发布输出', async () => {
    const backups = new DiaryBackupService()
    const internal = backups as unknown as {
      writeZip(
        output: string,
        directory: string,
        header: string,
        manifestFile: string,
        manifest: BackupManifest,
        guard?: () => void
      ): Promise<void>
    }
    const original = internal.writeZip.bind(backups)
    const spy = vi
      .spyOn(internal, 'writeZip')
      .mockImplementation((output, directory, header, _manifestFile, manifest, guard) =>
        original(
          output,
          directory,
          header,
          join(directory, 'missing-synthetic-manifest'),
          manifest,
          guard
        )
      )
    const outputPath = join(workDir, 'existing-source-error.zip')
    const previous = Buffer.from('previous backup must survive ZIP source error')
    await writeFile(outputPath, previous, { flag: 'wx' })
    try {
      await expect(
        backups.exportBackup(userId, notebookId, undefined, key, outputPath)
      ).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(outputPath)).toEqual(previous)
      expect(
        (await readdir(workDir)).some((name) => name.startsWith('.existing-source-error.zip.'))
      ).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('提取错误等待迟到 openReadStream 回调后再清零 key 和删除暂存', async () => {
    const backups = new DiaryBackupService()
    const internal = backups as unknown as {
      extractArchive(
        path: string,
        directory: string,
        temporaryKey: Buffer,
        operationId: string,
        guard?: () => void
      ): Promise<Map<string, unknown>>
    }
    const originalExtract = internal.extractArchive.bind(backups)
    let directory = ''
    let temporaryKey: Buffer | undefined
    const extractSpy = vi.spyOn(internal, 'extractArchive').mockImplementation((...args) => {
      directory = args[1]
      temporaryKey = args[2]
      return originalExtract(...args)
    })
    const prototype = yauzl.ZipFile.prototype as unknown as {
      openReadStream(
        entry: yauzl.Entry,
        callback: (error: Error | null, stream?: Readable) => void
      ): void
    }
    const originalOpen = prototype.openReadStream
    let release: (() => void) | undefined
    let notify: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const ready = new Promise<void>((resolve) => {
      notify = resolve
    })
    let observedZip: yauzl.ZipFile | undefined
    let observedStream: Readable | undefined
    const openSpy = vi.spyOn(prototype, 'openReadStream').mockImplementation(function (
      this: yauzl.ZipFile,
      entry,
      callback
    ) {
      originalOpen.call(this, entry, (error, stream) => {
        if (error || !stream) {
          callback(error, stream)
          return
        }
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        observedZip = this
        observedStream = stream
        notify()
        void gate.then(() => callback(null, stream))
      })
    })
    const importing = backups.importBackup(userId, 'backup-password', archivePath)
    let settled = false
    void importing.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    try {
      await ready
      observedZip!.emit('error', new Error('Synthetic extraction error before late callback'))
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(settled).toBe(false)
      expect(temporaryKey).not.toEqual(Buffer.alloc(32))
      expect(await readdir(directory)).toEqual([])
      release?.()
      await expect(importing).rejects.toMatchObject({ code: 'INVALID_BACKUP' })
      expect(observedStream!.destroyed).toBe(true)
      expect(temporaryKey).toEqual(Buffer.alloc(32))
      await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      release?.()
      await importing.catch(() => undefined)
      openSpy.mockRestore()
      extractSpy.mockRestore()
    }
  })

  it('提取流进行中出错会等待 pipeline 和 ZIP close 完成后再清理', async () => {
    const backups = new DiaryBackupService()
    const internal = backups as unknown as {
      extractArchive(
        path: string,
        directory: string,
        temporaryKey: Buffer,
        operationId: string,
        guard?: () => void
      ): Promise<Map<string, unknown>>
    }
    const originalExtract = internal.extractArchive.bind(backups)
    let directory = ''
    let temporaryKey: Buffer | undefined
    const extractSpy = vi.spyOn(internal, 'extractArchive').mockImplementation((...args) => {
      directory = args[1]
      temporaryKey = args[2]
      return originalExtract(...args)
    })
    const prototype = yauzl.ZipFile.prototype as unknown as {
      openReadStream(
        entry: yauzl.Entry,
        callback: (error: Error | null, stream?: Readable) => void
      ): void
    }
    const originalOpen = prototype.openReadStream
    let observedStream: Readable | undefined
    let streamClosed = false
    let zipClosed = false
    const openSpy = vi.spyOn(prototype, 'openReadStream').mockImplementation(function (
      this: yauzl.ZipFile,
      entry,
      callback
    ) {
      this.once('close', () => {
        zipClosed = true
      })
      originalOpen.call(this, entry, (error, stream) => {
        if (stream) {
          observedStream = stream
          stream.once('close', () => {
            streamClosed = true
          })
          stream.once('data', () =>
            this.emit('error', new Error('Synthetic active extraction error'))
          )
        }
        callback(error, stream)
      })
    })
    try {
      await expect(
        backups.importBackup(userId, 'backup-password', archivePath)
      ).rejects.toMatchObject({ code: 'INVALID_BACKUP' })
      expect(observedStream!.destroyed).toBe(true)
      expect(streamClosed).toBe(true)
      expect(zipClosed).toBe(true)
      expect(temporaryKey).toEqual(Buffer.alloc(32))
      await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      openSpy.mockRestore()
      extractSpy.mockRestore()
    }
  })

  it('条目超限在元数据阶段拒绝，不读取正文且不替换已有备份', async () => {
    const diaries = new DiaryRepository()
    const backups = new DiaryBackupService(new NotebookService(), new NotebookRepository(), diaries)
    const metadata = (await diaries.findMetadataInNotebook(notebookId))[0]
    const spy = vi.spyOn(diaries, 'findMetadataInNotebook').mockResolvedValue(
      Array.from({ length: BACKUP_MAX_ENTRIES - 1 }, (_, index) => ({
        ...metadata,
        id: index + 1,
        uuid: randomUUID()
      }))
    )
    const bodyRead = vi.spyOn(diaries, 'findInNotebook')
    const outputPath = join(workDir, 'existing-count.zip')
    const previous = Buffer.from('previous backup must survive count rejection')
    await writeFile(outputPath, previous, { flag: 'wx' })
    try {
      await expect(
        backups.exportBackup(userId, notebookId, undefined, key, outputPath)
      ).rejects.toMatchObject({ code: 'DIARY_TOO_LARGE' })
      expect(bodyRead).not.toHaveBeenCalled()
      expect(await readFile(outputPath)).toEqual(previous)
    } finally {
      spy.mockRestore()
      bodyRead.mockRestore()
    }
  })

  it('单条超限最早拒绝且不替换已有输出', async () => {
    const diaries = new DiaryRepository()
    const backups = new DiaryBackupService(new NotebookService(), new NotebookRepository(), diaries)
    const metadata = (await diaries.findMetadataInNotebook(notebookId))[0]
    const spy = vi
      .spyOn(diaries, 'findMetadataInNotebook')
      .mockResolvedValue([{ ...metadata, contentByteLength: DIARY_MARKDOWN_MAX_BYTES + 1 }])
    const bodyRead = vi.spyOn(diaries, 'findInNotebook')
    const outputPath = join(workDir, 'existing-size.zip')
    const previous = Buffer.from('previous backup must survive size rejection')
    await writeFile(outputPath, previous, { flag: 'wx' })
    try {
      await expect(
        backups.exportBackup(userId, notebookId, undefined, key, outputPath)
      ).rejects.toMatchObject({ code: 'DIARY_TOO_LARGE' })
      expect(bodyRead).not.toHaveBeenCalled()
      expect(await readFile(outputPath)).toEqual(previous)
    } finally {
      spy.mockRestore()
      bodyRead.mockRestore()
    }
  })

  it('总预算超限在逐条正文读取前拒绝', async () => {
    const diaries = new DiaryRepository()
    const images = new DiaryImageRepository()
    const backups = new DiaryBackupService(
      new NotebookService(),
      new NotebookRepository(),
      diaries,
      images
    )
    const metadata = (await diaries.findMetadataInNotebook(notebookId))[0]
    const diaryMetadata = vi.spyOn(diaries, 'findMetadataInNotebook').mockResolvedValue(
      Array.from({ length: 11 }, (_, index) => ({
        ...metadata,
        id: index + 1,
        uuid: randomUUID(),
        contentByteLength: 0
      }))
    )
    const imageMetadata = vi
      .spyOn(images, 'findMetadataForDiary')
      .mockImplementation(async (diaryId) =>
        Array.from({ length: 10 }, (_, index) => ({
          id: index + 1,
          diaryId,
          uuid: randomUUID(),
          mimeType: 'image/png',
          byteLength: DIARY_IMAGE_MAX_BYTES,
          ciphertextByteLength: DIARY_IMAGE_MAX_BYTES
        }))
      )
    const bodyRead = vi.spyOn(diaries, 'findInNotebook')
    const outputPath = join(workDir, 'existing-total.zip')
    const previous = Buffer.from('previous backup must survive total rejection')
    await writeFile(outputPath, previous, { flag: 'wx' })
    try {
      await expect(
        backups.exportBackup(userId, notebookId, undefined, key, outputPath)
      ).rejects.toMatchObject({ code: 'DIARY_TOO_LARGE' })
      expect(bodyRead).not.toHaveBeenCalled()
      expect(await readFile(outputPath)).toEqual(previous)
    } finally {
      diaryMetadata.mockRestore()
      imageMetadata.mockRestore()
      bodyRead.mockRestore()
    }
  })

  it('损坏的包装密钥元数据不能生成成功但无法恢复的备份', async () => {
    const notebooks = new NotebookService()
    const diaries = new DiaryRepository()
    const backups = new DiaryBackupService(notebooks, new NotebookRepository(), diaries)
    const notebook = await notebooks.requireOwned(userId, notebookId)
    const envelope = notebooks.envelope(notebook)
    const spy = vi
      .spyOn(notebooks, 'envelope')
      .mockReturnValue({ ...envelope, wrappedKeyNonce: Buffer.alloc(1).toString('base64') })
    const bodyRead = vi.spyOn(diaries, 'findInNotebook')
    const outputPath = join(workDir, 'existing-envelope.zip')
    const previous = Buffer.from('previous backup must survive schema rejection')
    await writeFile(outputPath, previous, { flag: 'wx' })
    try {
      await expect(
        backups.exportBackup(userId, notebookId, undefined, key, outputPath)
      ).rejects.toMatchObject({ code: 'DIARY_DATA_DAMAGED' })
      expect(bodyRead).not.toHaveBeenCalled()
      expect(await readFile(outputPath)).toEqual(previous)
    } finally {
      spy.mockRestore()
      bodyRead.mockRestore()
    }
  })

  it('ZIP 完成后取消不替换已有备份', async () => {
    const backups = new DiaryBackupService()
    const internal = backups as unknown as {
      writeZip(
        output: string,
        directory: string,
        header: string,
        manifestFile: string,
        manifest: BackupManifest
      ): Promise<void>
    }
    const original = internal.writeZip.bind(backups)
    let active = true
    const spy = vi.spyOn(internal, 'writeZip').mockImplementation(async (...args) => {
      await original(...args)
      active = false
    })
    const outputPath = join(workDir, 'existing-canceled.zip')
    const previous = Buffer.from('previous backup must survive cancellation')
    await writeFile(outputPath, previous, { flag: 'wx' })
    try {
      await expect(
        backups.exportBackup(userId, notebookId, undefined, key, outputPath, () => {
          if (!active) throw new AppError('Operation canceled.', 'NOTEBOOK_LOCKED')
        })
      ).rejects.toMatchObject({ code: 'NOTEBOOK_LOCKED' })
      expect(await readFile(outputPath)).toEqual(previous)
    } finally {
      spy.mockRestore()
    }
  })

  it('导入暂存文件全部是密文，返回 key 与内部 target 副本分离', async () => {
    const service = new DiaryService()
    const originalCreate = service.create.bind(service)
    let observedFiles = 0
    let observedTargetKey: Buffer | undefined
    const spy = vi
      .spyOn(service, 'create')
      .mockImplementation(async (owner, input, targetKey, guard) => {
        observedTargetKey = targetKey
        for (const name of (await readdir(tmpdir())).filter((entry) =>
          entry.startsWith('myapp-diary-import-')
        )) {
          const directory = join(tmpdir(), name)
          for (const file of await readdir(directory)) {
            const contents = await readFile(join(directory, file))
            expect(contents.includes(Buffer.from(secret))).toBe(false)
            expect(contents.includes(pngBytes)).toBe(false)
            observedFiles++
          }
        }
        return originalCreate(owner, input, targetKey, guard)
      })
    const backups = new DiaryBackupService(
      new NotebookService(),
      new NotebookRepository(),
      new DiaryRepository(),
      new DiaryImageRepository(),
      service
    )
    try {
      const imported = await backups.importBackup(userId, 'backup-password', archivePath)
      try {
        expect(observedFiles).toBeGreaterThan(0)
        expect(observedTargetKey).toEqual(Buffer.alloc(32))
        expect(imported.dataKey).not.toEqual(Buffer.alloc(32))
        expect(imported.dataKey).not.toBe(observedTargetKey)
      } finally {
        imported.dataKey.fill(0)
      }
    } finally {
      spy.mockRestore()
    }
  })

  it('导入嵌套日记创建后取消时整体回滚且内部 target key 清零', async () => {
    const service = new DiaryService()
    const originalCreate = service.create.bind(service)
    const beforeNotebooks = await Notebook.count()
    const beforeDiaries = await Diary.count()
    const beforeImages = await DiaryImage.count()
    let active = true
    let observedTargetKey: Buffer | undefined
    const spy = vi
      .spyOn(service, 'create')
      .mockImplementation(async (owner, input, targetKey, guard) => {
        observedTargetKey = targetKey
        const diary = await originalCreate(owner, input, targetKey, guard)
        active = false
        return diary
      })
    const backups = new DiaryBackupService(
      new NotebookService(),
      new NotebookRepository(),
      new DiaryRepository(),
      new DiaryImageRepository(),
      service
    )
    try {
      await expect(
        backups.importBackup(userId, 'backup-password', archivePath, () => {
          if (!active) throw new AppError('Operation canceled.', 'NOTEBOOK_LOCKED')
        })
      ).rejects.toMatchObject({ code: 'NOTEBOOK_LOCKED' })
    } finally {
      spy.mockRestore()
    }
    expect(await Notebook.count()).toBe(beforeNotebooks)
    expect(await Diary.count()).toBe(beforeDiaries)
    expect(await DiaryImage.count()).toBe(beforeImages)
    expect(observedTargetKey).toEqual(Buffer.alloc(32))
  })
})
