import 'reflect-metadata'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Buffer } from 'node:buffer'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Sequelize } from 'sequelize-typescript'
import * as yauzl from 'yauzl'
import * as yazl from 'yazl'

vi.mock('../../../src/main/logger', () => ({ default: { error: vi.fn() } }))
import { User } from '../../../src/main/database/models/user.model'
import { Notebook } from '../../../src/main/database/models/notebook.model'
import { Diary } from '../../../src/main/database/models/diary.model'
import { DiaryImage } from '../../../src/main/database/models/diary-image.model'
import UserRepository from '../../../src/main/database/repositories/UserRepository'
import NotebookService from '../../../src/main/services/NotebookService'
import DiaryService from '../../../src/main/services/DiaryService'
import DiaryBackupService from '../../../src/main/services/DiaryBackupService'

/**
 * End-to-end persistence and portable-backup test on in-memory SQLite:
 * encryption at rest, partial exports, transactional rollback, and tamper-safe
 * archive import/export.
 */
const models = [User, Notebook, Diary, DiaryImage]
const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
)
const gifBytes = Buffer.from(
  'R0lGODlhAQABAIAAAExpcf8AACH5BAUAAAAALAAAAAABAAEAAAICTAEAOw==',
  'base64'
)
const pngDataUrl = `data:image/png;base64,${pngBytes.toString('base64')}`
const gifDataUrl = `data:image/gif;base64,${gifBytes.toString('base64')}`

type ArchiveEntry = { name: string; data: Buffer }

async function readArchiveEntries(archivePath: string): Promise<ArchiveEntry[]> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (error, value) => {
      if (error || !value) reject(error ?? new Error('Unable to open test archive'))
      else resolve(value)
    })
  })
  const entries: ArchiveEntry[] = []
  await new Promise<void>((resolve, reject) => {
    zip.on('error', reject)
    zip.on('end', resolve)
    zip.on('entry', (entry: yauzl.Entry) => {
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          reject(error ?? new Error('Unable to read test archive entry'))
          return
        }
        const chunks: Buffer[] = []
        stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
        stream.on('error', reject)
        stream.on('end', () => {
          entries.push({ name: entry.fileName, data: Buffer.concat(chunks) })
          zip.readEntry()
        })
      })
    })
    zip.readEntry()
  })
  return entries
}

async function writeArchiveEntries(archivePath: string, entries: ArchiveEntry[]): Promise<void> {
  const zip = new yazl.ZipFile()
  for (const entry of entries) zip.addBuffer(entry.data, entry.name)
  const chunks: Buffer[] = []
  const output = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
    zip.outputStream.on('error', reject)
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
  })
  zip.end()
  await writeFile(archivePath, await output, { flag: 'wx' })
}

async function importTempDirectories(): Promise<Set<string>> {
  return new Set((await readdir(tmpdir())).filter((name) => name.startsWith('myapp-diary-import-')))
}

function createDatabase(): Sequelize {
  return new Sequelize({ dialect: 'sqlite', storage: ':memory:', models, logging: false })
}

describe('diary persistence and portable backups', () => {
  let database: Sequelize
  let workDir: string
  let archivePath: string
  let sourceUserId: number
  let sourceNotebookId: number
  let sourceSecondDiaryId: number
  let sourceKey: Buffer

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'myapp-diary-integration-'))
    archivePath = join(workDir, 'portable.zip')
    database = createDatabase()
    await database.sync({ force: true })

    const users = new UserRepository()
    const sourceUser = await users.create({
      name: 'Source User',
      email: 'source@example.com',
      password: 'source-password'
    })
    const otherUser = await users.create({
      name: 'Other User',
      email: 'other@example.com',
      password: 'other-password'
    })
    sourceUserId = sourceUser.id

    const notebooks = new NotebookService()
    const created = await notebooks.create(sourceUser.id, 'Private journal', 'portable-password')
    sourceNotebookId = created.dto.id
    sourceKey = created.dataKey

    const diaries = new DiaryService()
    const first = await diaries.create(
      sourceUser.id,
      {
        notebookId: sourceNotebookId,
        occurredAt: '2026-10-27T08:15:00.000Z',
        markdown: '# First\n\n![photo](draft-image://photo)',
        images: [
          {
            reference: 'draft-image://photo',
            mimeType: 'image/png',
            dataUrl: pngDataUrl
          }
        ]
      },
      sourceKey
    )
    const second = await diaries.create(
      sourceUser.id,
      {
        notebookId: sourceNotebookId,
        occurredAt: '2026-10-28T12:30:00.000Z',
        markdown: '# Second\n\n![one](draft-image://one)\n\n![two](draft-image://two)',
        images: [
          { reference: 'draft-image://one', mimeType: 'image/png', dataUrl: pngDataUrl },
          { reference: 'draft-image://two', mimeType: 'image/gif', dataUrl: gifDataUrl }
        ]
      },
      sourceKey
    )
    sourceSecondDiaryId = second.id

    const rawDiary = await Diary.findByPk(first.id, { raw: true, logging: false })
    const rawImage = await DiaryImage.findOne({
      where: { diaryId: first.id },
      raw: true,
      logging: false
    })
    // Raw rows store ciphertext, and model JSON must not expose key or ciphertext fields.
    expect(rawDiary!.contentCiphertext).not.toContain('# First')
    expect(rawImage!.ciphertext).not.toContain(pngBytes.toString('base64'))
    expect(JSON.stringify((await Notebook.findByPk(sourceNotebookId))!.toJSON())).not.toContain(
      'wrappedKey'
    )
    expect(JSON.stringify((await Diary.findByPk(first.id))!.toJSON())).not.toContain(
      'contentCiphertext'
    )
    expect(
      JSON.stringify((await DiaryImage.findOne({ where: { diaryId: first.id } }))!.toJSON())
    ).not.toContain('ciphertext')

    await expect(
      diaries.get(otherUser.id, sourceNotebookId, first.id, sourceKey)
    ).rejects.toMatchObject({
      code: 'NOTEBOOK_NOT_FOUND'
    })

    const backups = new DiaryBackupService()
    await expect(
      backups.exportBackup(sourceUser.id, sourceNotebookId, undefined, sourceKey, archivePath)
    ).resolves.toEqual({ canceled: false, diaryCount: 2 })
    expect((await readFile(archivePath)).includes(Buffer.from('# First'))).toBe(false)

    const exportedEntries = await readArchiveEntries(archivePath)
    const exportedHeader = JSON.parse(
      exportedEntries.find((entry) => entry.name === 'header.json')!.data.toString('utf8')
    )
    expect(exportedHeader.sourceUserId).toBe(sourceUserId)
  })

  afterAll(async () => {
    sourceKey?.fill(0)
    await database?.close()
    await rm(workDir, { recursive: true, force: true })
    pngBytes.fill(0)
    gifBytes.fill(0)
  })

  it('exports only explicitly selected diaries', async () => {
    const partialPath = join(workDir, 'partial.zip')
    const backups = new DiaryBackupService()
    await expect(
      backups.exportBackup(
        sourceUserId,
        sourceNotebookId,
        [sourceSecondDiaryId],
        sourceKey,
        partialPath
      )
    ).resolves.toEqual({ canceled: false, diaryCount: 1 })

    const partialEntries = await readArchiveEntries(partialPath)
    expect(partialEntries.filter((entry) => entry.name.startsWith('diaries/'))).toHaveLength(1)
    expect(partialEntries.filter((entry) => entry.name.startsWith('images/'))).toHaveLength(2)
  })

  it('rolls back diary and image writes if an image insert fails', async () => {
    const diaries = new DiaryService()
    const beforeDiaries = await Diary.count()
    const beforeImages = await DiaryImage.count()
    const originalCreate = DiaryImage.create.bind(DiaryImage)
    let imageWrites = 0
    // Force the second image insert to fail to verify the diary+images transaction rolls back.
    const createSpy = vi.spyOn(DiaryImage, 'create').mockImplementation((values, options) => {
      imageWrites++
      if (imageWrites === 2) return Promise.reject(new Error('simulated image insert failure'))
      return originalCreate(values, options)
    })
    try {
      await expect(
        diaries.create(
          sourceUserId,
          {
            notebookId: sourceNotebookId,
            occurredAt: '2026-10-29T12:30:00.000Z',
            markdown: '![one](draft-image://one)\n\n![two](draft-image://two)',
            images: [
              { reference: 'draft-image://one', mimeType: 'image/png', dataUrl: pngDataUrl },
              { reference: 'draft-image://two', mimeType: 'image/gif', dataUrl: gifDataUrl }
            ]
          },
          sourceKey
        )
      ).rejects.toThrow()
    } finally {
      createSpy.mockRestore()
    }
    expect(await Diary.count()).toBe(beforeDiaries)
    expect(await DiaryImage.count()).toBe(beforeImages)
  })

  it('re-encrypts updates and removes unreferenced encrypted images atomically', async () => {
    const diaries = new DiaryService()
    const first = (await diaries.list(sourceUserId, sourceNotebookId, sourceKey)).find(
      (diary) => diary.occurredAt === '2026-10-27T08:15:00.000Z'
    )!
    const before = await Diary.findByPk(first.id, { raw: true, logging: false })
    expect(await DiaryImage.count({ where: { diaryId: first.id } })).toBe(1)

    const updated = await diaries.update(
      sourceUserId,
      {
        notebookId: sourceNotebookId,
        diaryId: first.id,
        occurredAt: '2026-10-27T09:00:00.000Z',
        markdown: '# Updated without images',
        images: []
      },
      sourceKey
    )
    const after = await Diary.findByPk(first.id, { raw: true, logging: false })

    expect(updated.markdown).toBe('# Updated without images')
    expect(after!.contentNonce).not.toBe(before!.contentNonce)
    expect(after!.contentCiphertext).not.toContain(updated.markdown)
    expect(await DiaryImage.count({ where: { diaryId: first.id } })).toBe(0)
  })

  it('rejects unsafe or damaged archives without writes and cleans temporary files', async () => {
    const originalEntries = await readArchiveEntries(archivePath)
    const diaryEntry = originalEntries.find((entry) => entry.name.startsWith('diaries/'))!
    const headerEntry = originalEntries.find((entry) => entry.name === 'header.json')!
    const mutations: Array<{
      name: string
      entries: ArchiveEntry[]
      patchName?: [string, string]
    }> = []

    const damagedHeader = JSON.parse(headerEntry.data.toString('utf8'))
    const damagedTag = Buffer.from(damagedHeader.manifest.tag, 'base64')
    damagedTag[0] ^= 0xff
    damagedHeader.manifest.tag = damagedTag.toString('base64')
    mutations.push({
      name: 'damaged-tag',
      entries: originalEntries.map((entry) =>
        entry.name === 'header.json'
          ? { ...entry, data: Buffer.from(JSON.stringify(damagedHeader)) }
          : entry
      )
    })

    const unsupportedHeader = JSON.parse(headerEntry.data.toString('utf8'))
    unsupportedHeader.version = 999
    mutations.push({
      name: 'unsupported-version',
      entries: originalEntries.map((entry) =>
        entry.name === 'header.json'
          ? { ...entry, data: Buffer.from(JSON.stringify(unsupportedHeader)) }
          : entry
      )
    })

    const damagedDiary = Buffer.from(diaryEntry.data)
    damagedDiary[0] ^= 0xff
    mutations.push({
      name: 'damaged-ciphertext',
      entries: originalEntries.map((entry) =>
        entry.name === diaryEntry.name ? { ...entry, data: damagedDiary } : entry
      )
    })
    mutations.push({
      name: 'missing-entry',
      entries: originalEntries.filter((entry) => entry.name !== diaryEntry.name)
    })
    mutations.push({
      name: 'unexpected-entry',
      entries: [...originalEntries, { name: 'unexpected.txt', data: Buffer.from('unexpected') }]
    })
    mutations.push({
      name: 'duplicate-entry',
      entries: [...originalEntries, { name: 'header.json', data: Buffer.from(headerEntry.data) }]
    })
    mutations.push({
      name: 'path-traversal',
      entries: [...originalEntries, { name: 'xx/escape', data: Buffer.from('escape') }],
      patchName: ['xx/escape', '../escape']
    })
    mutations.push({
      name: 'compression-ratio',
      entries: [...originalEntries, { name: 'compressed.bin', data: Buffer.alloc(1024 * 1024, 0) }]
    })

    const backups = new DiaryBackupService()
    const notebookCount = await Notebook.count()
    const diaryCount = await Diary.count()
    const imageCount = await DiaryImage.count()
    const temporaryDirectories = await importTempDirectories()
    for (const mutation of mutations) {
      const mutatedPath = join(workDir, `${mutation.name}.zip`)
      await writeArchiveEntries(mutatedPath, mutation.entries)
      if (mutation.patchName) {
        const archive = await readFile(mutatedPath)
        const from = Buffer.from(mutation.patchName[0])
        const to = Buffer.from(mutation.patchName[1])
        // Rewrite the entry name in place; equal lengths keep the ZIP offsets valid.
        expect(to.length).toBe(from.length)
        let offset = 0
        let replacements = 0
        while ((offset = archive.indexOf(from, offset)) !== -1) {
          to.copy(archive, offset)
          offset += to.length
          replacements++
        }
        expect(replacements).toBeGreaterThanOrEqual(2)
        await writeFile(mutatedPath, archive)
      }

      await expect(
        backups.importBackup(sourceUserId, 'portable-password', mutatedPath)
      ).rejects.toMatchObject({ code: 'INVALID_BACKUP' })
      expect(await Notebook.count(), mutation.name).toBe(notebookCount)
      expect(await Diary.count(), mutation.name).toBe(diaryCount)
      expect(await DiaryImage.count(), mutation.name).toBe(imageCount)
      expect(await importTempDirectories(), mutation.name).toEqual(temporaryDirectories)
    }
  })

  it('keeps the original owner when imported into the same account', async () => {
    const backups = new DiaryBackupService()
    const imported = await backups.importBackup(sourceUserId, 'portable-password', archivePath)
    try {
      // A second import into the same account gets a deduplicated name but the same owner.
      expect(imported.result.notebook!.name).toBe('Private journal（导入 2）')
      const notebook = await Notebook.findByPk(imported.result.notebook!.id, {
        raw: true,
        logging: false
      })
      expect(notebook!.userId).toBe(sourceUserId)
    } finally {
      imported.dataKey.fill(0)
    }
  })

  it('restores on a fresh database using only the archive password', async () => {
    sourceKey.fill(0)
    await database.close()

    database = createDatabase()
    await database.sync({ force: true })
    // Create an unrelated user first so the target account id differs from the
    // source account id recorded in the backup header.
    await new UserRepository().create({
      name: 'Unrelated User',
      email: 'unrelated@example.com',
      password: 'unrelated-password'
    })
    const targetUser = await new UserRepository().create({
      name: 'Target User',
      email: 'target@example.com',
      password: 'target-password'
    })
    expect(targetUser.id).not.toBe(sourceUserId)
    const backups = new DiaryBackupService()

    await expect(
      backups.importBackup(targetUser.id, 'wrong-password', archivePath)
    ).rejects.toMatchObject({
      code: 'INVALID_NOTEBOOK_PASSWORD'
    })
    expect(await Notebook.count()).toBe(0)

    const imported = await backups.importBackup(targetUser.id, 'portable-password', archivePath)
    try {
      expect(imported.result).toMatchObject({ canceled: false, diaryCount: 2 })
      expect(imported.result.notebook!.name).toBe('Private journal')
      // A backup imported into a different account is reassigned to the
      // importing user.
      const importedNotebook = await Notebook.findByPk(imported.result.notebook!.id, {
        raw: true,
        logging: false
      })
      expect(importedNotebook!.userId).toBe(targetUser.id)
      const diaries = new DiaryService()
      const summaries = await diaries.list(
        targetUser.id,
        imported.result.notebook!.id,
        imported.dataKey
      )
      expect(summaries).toHaveLength(2)
      // 内存 SQLite 共享单连接，逐个完成一致读取快照，避免并发 BEGIN。
      const restored: Awaited<ReturnType<DiaryService['get']>>[] = []
      for (const summary of summaries) {
        restored.push(
          await diaries.get(targetUser.id, summary.notebookId, summary.id, imported.dataKey)
        )
      }
      const second = restored.find((diary) => diary.markdown.startsWith('# Second'))!
      expect(second.images).toHaveLength(2)
      expect(second.markdown).toMatch(/diary-image:\/\//)
      expect(second.images.map((image) => image.dataUrl)).toEqual(
        expect.arrayContaining([pngDataUrl, gifDataUrl])
      )

      const duplicate = await backups.importBackup(targetUser.id, 'portable-password', archivePath)
      try {
        expect(duplicate.result.notebook!.name).toBe('Private journal（导入 2）')
        expect(duplicate.result.notebook!.uuid).not.toBe(imported.result.notebook!.uuid)
      } finally {
        duplicate.dataKey.fill(0)
      }
    } finally {
      imported.dataKey.fill(0)
    }
  })
})
