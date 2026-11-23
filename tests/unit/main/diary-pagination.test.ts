import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Sequelize } from 'sequelize-typescript'
import type { Transaction } from 'sequelize'

vi.mock('../../../src/main/logger', () => ({ default: { error: vi.fn() } }))
import { User } from '../../../src/main/database/models/user.model'
import { Notebook } from '../../../src/main/database/models/notebook.model'
import { Diary } from '../../../src/main/database/models/diary.model'
import { DiaryImage } from '../../../src/main/database/models/diary-image.model'
import UserRepository from '../../../src/main/database/repositories/UserRepository'
import DiaryRepository from '../../../src/main/database/repositories/DiaryRepository'
import NotebookService from '../../../src/main/services/NotebookService'
import DiaryService from '../../../src/main/services/DiaryService'
import { diaryContentAad, encryptText } from '../../../src/main/crypto/notebook-crypto'
import * as notebookCrypto from '../../../src/main/crypto/notebook-crypto'
import { DIARY_MARKDOWN_MAX_BYTES } from '../../../src/common/diary-limits'
import { AppError } from '../../../src/main/errors'
import type { DiaryPageOptionsDTO } from '../../../src/common/diary'

const occurredAt = new Date('2026-11-20T08:00:00.000Z')

describe('日记分页的内存 SQLite 安全边界', () => {
  let database: Sequelize
  let userId: number
  let otherUserId: number
  let notebookId: number
  let emptyNotebookId: number
  let key: Buffer
  let diaries: DiaryRepository
  let notebooks: NotebookService
  let service: DiaryService
  let ids: number[]

  beforeAll(async () => {
    database = new Sequelize({
      dialect: 'sqlite',
      storage: ':memory:',
      models: [User, Notebook, Diary, DiaryImage],
      logging: false
    })
    await database.sync({ force: true })
    const users = new UserRepository()
    userId = (
      await users.create({
        name: '分页测试用户',
        email: 'pagination@example.test',
        password: 'synthetic-password'
      })
    ).id
    otherUserId = (
      await users.create({
        name: '另一个合成用户',
        email: 'pagination-other@example.test',
        password: 'synthetic-password'
      })
    ).id
    notebooks = new NotebookService()
    const notebook = await notebooks.create(userId, '分页测试', 'notebook-password')
    notebookId = notebook.dto.id
    key = notebook.dataKey
    const empty = await notebooks.create(userId, '空日记本', 'notebook-password')
    emptyNotebookId = empty.dto.id
    empty.dataKey.fill(0)
    const other = await notebooks.create(otherUserId, '其他用户日记本', 'notebook-password')
    other.dataKey.fill(0)
    diaries = new DiaryRepository()
    service = new DiaryService(notebooks, diaries)
    ids = []
    for (let index = 1; index <= 106; index++) {
      const uuid = randomUUID()
      const encrypted = encryptText(
        `# 日记 ${index}\n\n当前页预览`,
        key,
        diaryContentAad(notebook.dto.uuid, uuid, occurredAt.toISOString())
      )
      const diary = await diaries.create({
        uuid,
        notebookId,
        occurredAt,
        contentCiphertext: encrypted.ciphertext,
        contentNonce: encrypted.nonce,
        contentTag: encrypted.tag
      })
      if (index === 106) await diaries.deleteInNotebook(notebookId, diary.id)
      else ids.unshift(diary.id)
    }
    await diaries.create({
      uuid: randomUUID(),
      notebookId: other.dto.id,
      occurredAt,
      contentCiphertext: 'AAAA',
      contentNonce: 'unused',
      contentTag: 'unused'
    })
  })

  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    key?.fill(0)
    await database?.close()
  })

  it('默认20条，稳定按相同 occurredAt 的 id 降序，排除软删除和其他日记本', async () => {
    const result = await service.listPage(userId, notebookId, key)
    expect(result).toMatchObject({ total: 105, page: 1, pageSize: 20 })
    expect(result.items.map((item) => item.id)).toEqual(ids.slice(0, 20))
    expect(result.items[0].title).toBe('日记 105')
    expect(await diaries.countInNotebook(notebookId)).toBe(105)
  })

  it('旧 list 仍返回完整列表，不调用分页 COUNT 或引入默认20条限制', async () => {
    const count = vi.spyOn(diaries, 'countInNotebook')
    const metadata = vi.spyOn(diaries, 'findMetadataInNotebook')
    const result = await service.list(userId, notebookId, key)
    expect(result.map((item) => item.id)).toEqual(ids)
    expect(count).not.toHaveBeenCalled()
    expect(metadata.mock.calls[0][2]?.limit).toBeUndefined()
    expect(metadata.mock.calls[0][2]?.offset).toBeUndefined()
  })

  it('分页解密完成后的会话撤销不会被单条预览容错吞掉', async () => {
    let active = true
    const decrypt = notebookCrypto.decryptText
    vi.spyOn(notebookCrypto, 'decryptText').mockImplementation((...args) => {
      const text = decrypt(...args)
      active = false
      return text
    })
    await expect(
      service.listPage(userId, notebookId, key, { pageSize: 1 }, () => {
        if (!active) throw new AppError('Operation canceled.', 'OPERATION_CANCELLED')
      })
    ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
  })

  it('最大100条的第二页只返回余下5条', async () => {
    const first = await service.listPage(userId, notebookId, key, { pageSize: 100 })
    const last = await service.listPage(userId, notebookId, key, { page: 2, pageSize: 100 })
    expect(first.items).toHaveLength(100)
    expect(last).toMatchObject({ total: 105, page: 2, pageSize: 100 })
    expect(last.items.map((item) => item.id)).toEqual(ids.slice(100))
  })

  it('越过末页夹到第6页，空日记本仍返回第1页', async () => {
    const last = await service.listPage(userId, notebookId, key, { page: 999 })
    expect(last).toMatchObject({ total: 105, page: 6, pageSize: 20 })
    expect(last.items.map((item) => item.id)).toEqual(ids.slice(100))
    const metadata = vi.spyOn(diaries, 'findMetadataInNotebook')
    expect(await service.listPage(userId, emptyNotebookId, key, { page: 999 })).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20
    })
    expect(metadata).not.toHaveBeenCalled()
  })

  const invalidOptions: DiaryPageOptionsDTO[] = [
    { page: 0 },
    { page: -1 },
    { page: NaN },
    { page: Infinity },
    { page: 1.5 },
    { page: Number.MAX_SAFE_INTEGER },
    { page: Math.floor(Number.MAX_SAFE_INTEGER / 100) + 1, pageSize: 1 },
    { pageSize: 0 },
    { pageSize: 101 },
    { pageSize: NaN },
    { pageSize: Infinity },
    { pageSize: 1.5 },
    { pageSize: -1 }
  ]
  it.each(invalidOptions)('服务独立拒绝非法数值 %j，不执行 COUNT 或元数据查询', async (options) => {
    const count = vi.spyOn(diaries, 'countInNotebook')
    const metadata = vi.spyOn(diaries, 'findMetadataInNotebook')
    await expect(service.listPage(userId, notebookId, key, options)).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    })
    expect(count).not.toHaveBeenCalled()
    expect(metadata).not.toHaveBeenCalled()
  })

  it('非法页码也必须先确认归属和32字节密钥，拒绝其他用户', async () => {
    const count = vi.spyOn(diaries, 'countInNotebook')
    await expect(service.listPage(otherUserId, notebookId, key, { page: 0 })).rejects.toMatchObject(
      { code: 'NOTEBOOK_NOT_FOUND' }
    )
    await expect(
      service.listPage(userId, notebookId, Buffer.alloc(31), { page: 0 })
    ).rejects.toMatchObject({ code: 'NOTEBOOK_LOCKED' })
    expect(count).not.toHaveBeenCalled()
  })

  it('SQL COUNT 和 limit/offset 元数据查询共用快照，只解密当前页而不加载全表', async () => {
    const count = vi.spyOn(Diary, 'count')
    const queries = vi.spyOn(Diary, 'findAll')
    const metadata = vi.spyOn(diaries, 'findMetadataInNotebook')
    const bodies = vi.spyOn(diaries, 'findInNotebook')
    const all = vi.spyOn(diaries, 'findAllInNotebook')
    const selected = vi.spyOn(diaries, 'findSelectedInNotebook')
    const snapshot = vi.spyOn(diaries, 'readSnapshot')
    const result = await service.listPage(userId, notebookId, key, { page: 3, pageSize: 7 })
    expect(result.items.map((item) => item.id)).toEqual(ids.slice(14, 21))
    expect(count).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ where: { notebookId } })
    )
    expect(metadata).toHaveBeenCalledExactlyOnceWith(
      notebookId,
      [],
      expect.objectContaining({
        limit: 7,
        offset: 14
      })
    )
    const transaction = count.mock.calls[0][0]?.transaction
    expect(transaction).toBeDefined()
    expect(metadata.mock.calls[0][2]?.transaction).toBe(transaction)
    expect(bodies.mock.calls.map((call) => call[1])).toEqual(ids.slice(14, 21))
    expect(bodies.mock.calls.every((call) => call[2]?.transaction === transaction)).toBe(true)
    const metadataQuery = queries.mock.calls.find(([query]) =>
      Array.isArray(query?.attributes)
    )?.[0]
    expect(metadataQuery).toMatchObject({ limit: 7, offset: 14, where: { notebookId } })
    expect(metadataQuery?.attributes).not.toContain('contentCiphertext')
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(all).not.toHaveBeenCalled()
    expect(selected).not.toHaveBeenCalled()
  })

  it('每页32 MiB预算、单条上限和损坏保护不会移除元数据卡片，下一页预算独立', async () => {
    const [template] = await diaries.findMetadataInNotebook(notebookId, [ids[0]])
    const stored = await diaries.findInNotebook(notebookId, ids[0])
    const entries = Array.from({ length: 16 }, (_, index) => ({
      ...template,
      id: index + 1,
      contentByteLength: DIARY_MARKDOWN_MAX_BYTES
    }))
    entries.push({ ...template, id: 17, contentByteLength: 1 })
    entries.push({ ...template, id: 18, contentByteLength: DIARY_MARKDOWN_MAX_BYTES + 1 })
    entries.push({ ...template, id: 19, contentByteLength: 0 })
    entries.push({ ...template, id: 20, contentByteLength: NaN })
    vi.spyOn(diaries, 'countInNotebook').mockResolvedValue(21)
    vi.spyOn(diaries, 'findMetadataInNotebook')
      .mockResolvedValueOnce(entries)
      .mockResolvedValueOnce([{ ...template, contentByteLength: 1 }])
    const bodies = vi.spyOn(diaries, 'findInNotebook').mockResolvedValue(stored)
    const first = await service.listPage(userId, notebookId, key)
    expect(first.items).toHaveLength(20)
    expect(bodies.mock.calls.map((call) => call[1])).toEqual([
      ...Array.from({ length: 16 }, (_, index) => index + 1),
      19
    ])
    for (const index of [16, 17, 19]) {
      expect(first.items[index].title).toBeUndefined()
      expect(first.items[index].preview).toBeUndefined()
    }
    expect(first.items[15].title).toBe('日记 105')
    const second = await service.listPage(userId, notebookId, key, { page: 2 })
    expect(second.items[0].title).toBe('日记 105')
  })

  it('认证损坏仅退化当前卡片，其他卡片保留预览', async () => {
    const read = diaries.findInNotebook.bind(diaries)
    vi.spyOn(diaries, 'findInNotebook').mockImplementation(async (...args) => {
      const diary = await read(...args)
      if (diary && diary.id === ids[0]) diary.setDataValue('contentTag', 'damaged')
      return diary
    })
    const result = await service.listPage(userId, notebookId, key, { pageSize: 2 })
    expect(result.items).toHaveLength(2)
    expect(result.items[0]).not.toHaveProperty('title')
    expect(result.items[1].title).toBe('日记 104')
  })

  it.each(['ownership', 'count', 'metadata', 'body', 'snapshot'] as const)(
    '在 %s 的 await 后撤销会话必须中止，不吞掉守卫异常',
    async (stage) => {
      let active = true
      const guard = () => {
        if (!active) throw new AppError('Operation canceled.', 'OPERATION_CANCELLED')
      }
      if (stage === 'ownership') {
        const read = notebooks.requireOwned.bind(notebooks)
        vi.spyOn(notebooks, 'requireOwned').mockImplementation(async (...args) => {
          const result = await read(...args)
          active = false
          return result
        })
      } else if (stage === 'count') {
        const read = diaries.countInNotebook.bind(diaries)
        vi.spyOn(diaries, 'countInNotebook').mockImplementation(async (...args) => {
          const result = await read(...args)
          active = false
          return result
        })
      } else if (stage === 'metadata') {
        const read = diaries.findMetadataInNotebook.bind(diaries)
        vi.spyOn(diaries, 'findMetadataInNotebook').mockImplementation(async (...args) => {
          const result = await read(...args)
          active = false
          return result
        })
      } else if (stage === 'body') {
        const read = diaries.findInNotebook.bind(diaries)
        vi.spyOn(diaries, 'findInNotebook').mockImplementation(async (...args) => {
          const result = await read(...args)
          active = false
          return result
        })
      } else {
        const read = diaries.readSnapshot.bind(diaries)
        vi.spyOn(diaries, 'readSnapshot').mockImplementation(
          async <R>(operation: (transaction: Transaction) => Promise<R>): Promise<R> => {
            const result = await read(operation)
            active = false
            return result
          }
        )
      }
      await expect(
        service.listPage(userId, notebookId, key, { pageSize: 1 }, guard)
      ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
    }
  )
})
