import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Sequelize } from 'sequelize-typescript'

vi.mock('../../../src/main/logger', () => ({ default: { error: vi.fn() } }))
import { User } from '../../../src/main/database/models/user.model'
import { Notebook } from '../../../src/main/database/models/notebook.model'
import { Diary } from '../../../src/main/database/models/diary.model'
import { DiaryImage } from '../../../src/main/database/models/diary-image.model'
import UserRepository from '../../../src/main/database/repositories/UserRepository'
import DiaryRepository from '../../../src/main/database/repositories/DiaryRepository'
import DiaryImageRepository from '../../../src/main/database/repositories/DiaryImageRepository'
import NotebookRepository from '../../../src/main/database/repositories/NotebookRepository'
import NotebookService from '../../../src/main/services/NotebookService'
import DiaryService from '../../../src/main/services/DiaryService'
import { AppError } from '../../../src/main/errors'
import { DIARY_IMAGE_MAX_BYTES, DIARY_MARKDOWN_MAX_BYTES } from '../../../src/common/diary-limits'
import * as imageValidation from '../../../src/main/services/image-validation'
import { diaryImageAad, encryptBytes } from '../../../src/main/crypto/notebook-crypto'

const pngDataUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const occurredAt = '2026-11-20T08:00:00.000Z'
function imageInput(index: number): { reference: string; mimeType: 'image/png'; dataUrl: string } {
  return { reference: `draft-image://image${index}`, mimeType: 'image/png', dataUrl: pngDataUrl }
}

describe('日记服务安全边界', () => {
  let database: Sequelize
  let userId: number
  let notebookId: number
  let key: Buffer
  beforeAll(async () => {
    database = new Sequelize({
      dialect: 'sqlite',
      storage: ':memory:',
      models: [User, Notebook, Diary, DiaryImage],
      logging: false
    })
    await database.sync({ force: true })
    const user = await new UserRepository().create({
      name: 'Security test',
      email: 'diary-security@example.com',
      password: 'test-password'
    })
    userId = user.id
    const created = await new NotebookService().create(
      userId,
      'Security journal',
      'notebook-password'
    )
    notebookId = created.dto.id
    key = created.dataKey
  })
  afterAll(async () => {
    key?.fill(0)
    await database?.close()
  })

  it('拒绝仅有 PNG 签名的伪图片且不写数据库', async () => {
    const before = await Diary.count()
    await expect(
      new DiaryService().create(
        userId,
        {
          notebookId,
          occurredAt,
          markdown: '![bad](draft-image://bad)',
          images: [
            {
              reference: 'draft-image://bad',
              mimeType: 'image/png',
              dataUrl: 'data:image/png;base64,iVBORw0KGgo='
            }
          ]
        },
        key
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(await Diary.count()).toBe(before)
  })

  it('最终旧图片加新图片不能超过 40 张，失败不删除旧图', async () => {
    const service = new DiaryService()
    const inputs = Array.from({ length: 40 }, (_, index) => imageInput(index))
    const created = await service.create(
      userId,
      {
        notebookId,
        occurredAt,
        markdown: inputs.map((image) => `![x](${image.reference})`).join('\n'),
        images: inputs
      },
      key
    )
    await expect(
      service.update(
        userId,
        {
          notebookId,
          diaryId: created.id,
          occurredAt,
          markdown: `${created.markdown}\n![new](draft-image://image40)`,
          images: [imageInput(40)]
        },
        key
      )
    ).rejects.toMatchObject({ code: 'DIARY_TOO_LARGE' })
    expect(await DiaryImage.count({ where: { diaryId: created.id } })).toBe(40)
    expect((await service.get(userId, notebookId, created.id, key)).markdown).toBe(created.markdown)
  })

  it('最终保留旧图与新增图片的解码字节总量不能超过 100 MiB', async () => {
    const diaries = new DiaryRepository()
    const images = new DiaryImageRepository()
    const service = new DiaryService(new NotebookService(), diaries, images)
    const created = await service.create(
      userId,
      { notebookId, occurredAt, markdown: 'old', images: [] },
      key
    )
    const metadata = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      diaryId: created.id,
      uuid: randomUUID(),
      mimeType: 'image/png',
      byteLength: DIARY_IMAGE_MAX_BYTES,
      ciphertextByteLength: DIARY_IMAGE_MAX_BYTES
    }))
    const spy = vi.spyOn(images, 'findMetadataForDiary').mockResolvedValue(metadata)
    try {
      const markdown = `${metadata.map((image) => `![old](diary-image://${image.uuid})`).join('\n')}\n![new](draft-image://image0)`
      await expect(
        service.update(
          userId,
          { notebookId, diaryId: created.id, occurredAt, markdown, images: [imageInput(0)] },
          key
        )
      ).rejects.toMatchObject({ code: 'DIARY_TOO_LARGE' })
    } finally {
      spy.mockRestore()
    }
    expect((await service.get(userId, notebookId, created.id, key)).markdown).toBe('old')
  })

  it('旧超限图片只读元数据后拒绝，绝不加载全部图片密文', async () => {
    const diaries = new DiaryRepository()
    const images = new DiaryImageRepository()
    const service = new DiaryService(new NotebookService(), diaries, images)
    const created = await service.create(
      userId,
      { notebookId, occurredAt, markdown: '', images: [] },
      key
    )
    const read = vi.spyOn(images, 'findAllForDiary')
    const metadata = vi.spyOn(images, 'findMetadataForDiary').mockResolvedValue([
      {
        id: 1,
        diaryId: created.id,
        uuid: randomUUID(),
        mimeType: 'image/png',
        byteLength: 1,
        ciphertextByteLength: 500 * 1024 * 1024
      }
    ])
    try {
      await expect(service.get(userId, notebookId, created.id, key)).rejects.toMatchObject({
        code: 'DIARY_TOO_LARGE'
      })
      expect(read).not.toHaveBeenCalled()
    } finally {
      metadata.mockRestore()
      read.mockRestore()
    }
  })

  it('旧超限正文只读 SQL 长度后拒绝，不读取正文密文', async () => {
    const diaries = new DiaryRepository()
    const service = new DiaryService(new NotebookService(), diaries)
    const created = await service.create(
      userId,
      { notebookId, occurredAt, markdown: '', images: [] },
      key
    )
    const originalMetadata = await diaries.findMetadataInNotebook(notebookId, [created.id])
    const metadata = vi
      .spyOn(diaries, 'findMetadataInNotebook')
      .mockResolvedValue([
        { ...originalMetadata[0], contentByteLength: DIARY_MARKDOWN_MAX_BYTES + 1 }
      ])
    const read = vi.spyOn(diaries, 'findInNotebook')
    try {
      await expect(service.get(userId, notebookId, created.id, key)).rejects.toMatchObject({
        code: 'DIARY_TOO_LARGE'
      })
      expect(read).not.toHaveBeenCalled()
    } finally {
      metadata.mockRestore()
      read.mockRestore()
    }
  })

  it('SQLite 元数据长度计入 NUL 后的完整 UTF-8 存储，图片损坏时不读取密文', async () => {
    const diaries = new DiaryRepository()
    const images = new DiaryImageRepository()
    const service = new DiaryService(new NotebookService(), diaries, images)
    const created = await service.create(
      userId,
      { notebookId, occurredAt, markdown: 'small', images: [] },
      key
    )
    const damaged = 'AAAA\0中BBBBBB'
    const expectedLength = Math.floor(Buffer.byteLength(damaged, 'utf8') / 4) * 3
    await diaries.update(created.id, { contentCiphertext: damaged })
    await images.create({
      uuid: randomUUID(),
      diaryId: created.id,
      mimeType: 'image/png',
      byteLength: 3,
      ciphertext: damaged,
      nonce: 'unused',
      tag: 'unused'
    })
    expect(
      (await diaries.findMetadataInNotebook(notebookId, [created.id]))[0].contentByteLength
    ).toBe(expectedLength)
    expect((await images.findMetadataForDiary(created.id))[0].ciphertextByteLength).toBe(
      expectedLength
    )
    const bodyRead = vi.spyOn(diaries, 'findInNotebook')
    const imageRead = vi.spyOn(images, 'findAllForDiary')
    try {
      await expect(service.get(userId, notebookId, created.id, key)).rejects.toMatchObject({
        code: 'DIARY_TOO_LARGE'
      })
      expect(bodyRead).not.toHaveBeenCalled()
      expect(imageRead).not.toHaveBeenCalled()
    } finally {
      bodyRead.mockRestore()
      imageRead.mockRestore()
    }
  })

  it('SQLite 中 NUL 开头的超限旧正文在 get 读取前被拒绝，但仍可仅投影元数据软删除', async () => {
    const diaries = new DiaryRepository()
    const images = new DiaryImageRepository()
    const service = new DiaryService(new NotebookService(), diaries, images)
    const created = await service.create(
      userId,
      { notebookId, occurredAt, markdown: 'small', images: [] },
      key
    )
    await images.create({
      uuid: randomUUID(),
      diaryId: created.id,
      mimeType: 'image/png',
      byteLength: DIARY_IMAGE_MAX_BYTES + 1,
      ciphertext: 'damaged',
      nonce: 'unused',
      tag: 'unused'
    })
    // 在内存 SQLite 中构造仅略超单条上限的 TEXT，避免在 JS 分配大字符串或图片。
    const encodedLength = Math.ceil((DIARY_MARKDOWN_MAX_BYTES + 1) / 3) * 4
    await database.query(
      "UPDATE diaries SET content_ciphertext = char(0) || printf('%.*c', :remaining, 'A') WHERE id = :id",
      { replacements: { remaining: encodedLength - 1, id: created.id }, logging: false }
    )
    expect(
      (await diaries.findMetadataInNotebook(notebookId, [created.id]))[0].contentByteLength
    ).toBe(DIARY_MARKDOWN_MAX_BYTES + 1)
    const bodyRead = vi.spyOn(diaries, 'findInNotebook')
    const imageRead = vi.spyOn(images, 'findAllForDiary')
    const metadataReads = vi.spyOn(Diary, 'findAll')
    const identityReads = vi.spyOn(Diary, 'findOne')
    const childReads = vi.spyOn(DiaryImage, 'findAll')
    const beforeDestroy = vi.fn()
    const afterDestroy = vi.fn()
    Diary.addHook('beforeDestroy', 'oversized-before', beforeDestroy)
    Diary.addHook('afterDestroy', 'oversized-after', afterDestroy)
    try {
      await expect(service.get(userId, notebookId, created.id, key)).rejects.toMatchObject({
        code: 'DIARY_TOO_LARGE'
      })
      expect(await service.delete(userId, notebookId, created.id)).toBe(true)
      expect(bodyRead).not.toHaveBeenCalled()
      expect(imageRead).not.toHaveBeenCalled()
      expect(childReads).not.toHaveBeenCalled()
      expect(beforeDestroy).toHaveBeenCalledTimes(1)
      expect(afterDestroy).toHaveBeenCalledTimes(1)
      expect(beforeDestroy.mock.calls[0][0].getDataValue('contentCiphertext')).toBeUndefined()
      expect(beforeDestroy.mock.calls[0][1].force).toBe(false)
      expect(afterDestroy.mock.calls[0][1].transaction).toBe(
        beforeDestroy.mock.calls[0][1].transaction
      )
      // findOne 内部复用 findAll：两次长度预检加一次作用域身份投影。
      expect(metadataReads).toHaveBeenCalledTimes(3)
      for (const [query] of metadataReads.mock.calls) {
        expect(query?.attributes).toEqual(expect.any(Array))
        expect(query?.attributes).not.toContain('contentCiphertext')
      }
      expect(identityReads).toHaveBeenCalledTimes(1)
      expect(identityReads.mock.calls[0][0]?.attributes).toEqual(
        expect.arrayContaining(['id', 'version', 'notebookId'])
      )
      expect(identityReads.mock.calls[0][0]?.attributes).not.toContain('contentCiphertext')
    } finally {
      bodyRead.mockRestore()
      imageRead.mockRestore()
      metadataReads.mockRestore()
      identityReads.mockRestore()
      childReads.mockRestore()
      Diary.removeHook('beforeDestroy', 'oversized-before')
      Diary.removeHook('afterDestroy', 'oversized-after')
    }
    const stored = await Diary.findByPk(created.id, {
      attributes: ['id', 'deletedAt'],
      paranoid: false,
      logging: false
    })
    expect(stored?.deletedAt).toBeInstanceOf(Date)
    expect(await DiaryImage.count({ where: { diaryId: created.id }, paranoid: false })).toBe(0)
    expect(await service.delete(userId, notebookId, created.id)).toBe(false)
  })

  it('真实父作用域不匹配时日记与图片均保持不变，图片删除使用元数据实例钩子', async () => {
    const diaries = new DiaryRepository()
    const images = new DiaryImageRepository()
    const service = new DiaryService(new NotebookService(), diaries, images)
    const created = await service.create(
      userId,
      {
        notebookId,
        occurredAt,
        markdown: '![x](draft-image://image0)',
        images: [imageInput(0)]
      },
      key
    )
    const other = await new NotebookService().create(userId, 'Other owner', 'notebook-password')
    other.dataKey.fill(0)
    const image = (await images.findAllForDiary(created.id))[0]
    expect(await diaries.deleteInNotebook(other.dto.id, created.id)).toBe(false)
    expect(await images.deleteInDiary(created.id + 1, image.id)).toBe(false)
    expect(await service.delete(userId, other.dto.id, created.id)).toBe(false)
    expect((await service.get(userId, notebookId, created.id, key)).markdown).toBe(created.markdown)
    const beforeDestroy = vi.fn()
    const afterDestroy = vi.fn()
    DiaryImage.addHook('beforeDestroy', 'scoped-image-before', beforeDestroy)
    DiaryImage.addHook('afterDestroy', 'scoped-image-after', afterDestroy)
    try {
      expect(await images.deleteInDiary(created.id, image.id)).toBe(true)
      expect(beforeDestroy).toHaveBeenCalledTimes(1)
      expect(afterDestroy).toHaveBeenCalledTimes(1)
      const instance = beforeDestroy.mock.calls[0][0] as DiaryImage
      expect(instance).toBeInstanceOf(DiaryImage)
      expect(instance.id).toBe(image.id)
      expect(instance.diaryId).toBe(created.id)
      expect(instance.getDataValue('ciphertext')).toBeUndefined()
      expect(instance.getDataValue('nonce')).toBeUndefined()
      expect(instance.getDataValue('tag')).toBeUndefined()
      expect(beforeDestroy.mock.calls[0][1].force).toBe(true)
      expect(afterDestroy.mock.calls[0][1].transaction).toBe(
        beforeDestroy.mock.calls[0][1].transaction
      )
    } finally {
      DiaryImage.removeHook('beforeDestroy', 'scoped-image-before')
      DiaryImage.removeHook('afterDestroy', 'scoped-image-after')
    }
    expect(await DiaryImage.findByPk(image.id, { paranoid: false, logging: false })).toBeNull()
    expect(await diaries.findInNotebook(notebookId, created.id)).not.toBeNull()
  })

  it('日记删除实例钩子失败会回滚先执行的图片清理', async () => {
    const service = new DiaryService()
    const created = await service.create(
      userId,
      {
        notebookId,
        occurredAt,
        markdown: '![x](draft-image://image0)',
        images: [imageInput(0)]
      },
      key
    )
    Diary.addHook('afterDestroy', 'rollback-child-cleanup', () => {
      throw new AppError('Deletion blocked.', 'DELETE_BLOCKED')
    })
    try {
      await expect(service.delete(userId, notebookId, created.id)).rejects.toMatchObject({
        code: 'DELETE_BLOCKED'
      })
    } finally {
      Diary.removeHook('afterDestroy', 'rollback-child-cleanup')
    }
    expect(await DiaryImage.count({ where: { diaryId: created.id } })).toBe(1)
    expect((await service.get(userId, notebookId, created.id, key)).markdown).toBe(created.markdown)
  })

  it('32 MiB 列表预览累计预算到边界后保留卡片，但不再读取超预算正文', async () => {
    const diaries = new DiaryRepository()
    const service = new DiaryService(new NotebookService(), diaries)
    const created = await service.create(
      userId,
      { notebookId, occurredAt, markdown: '# Small preview', images: [] },
      key
    )
    const [template] = await diaries.findMetadataInNotebook(notebookId, [created.id])
    const entries = Array.from({ length: 16 }, (_, index) => ({
      ...template,
      id: index + 1,
      contentByteLength: DIARY_MARKDOWN_MAX_BYTES
    }))
    entries.push({ ...template, id: 17, contentByteLength: 1 })
    entries.push({ ...template, id: 18, contentByteLength: DIARY_MARKDOWN_MAX_BYTES + 1 })
    entries.push({ ...template, id: 19, contentByteLength: 0 })
    const stored = await diaries.findInNotebook(notebookId, created.id)
    const metadata = vi.spyOn(diaries, 'findMetadataInNotebook').mockResolvedValue(entries)
    const read = vi.spyOn(diaries, 'findInNotebook').mockResolvedValue(stored)
    try {
      const cards = await service.list(userId, notebookId, key)
      expect(cards).toHaveLength(entries.length)
      expect(read.mock.calls.map((call) => call[1])).toEqual([
        ...Array.from({ length: 16 }, (_, index) => index + 1),
        19
      ])
      expect(cards[0]).toHaveProperty('title', 'Small preview')
      expect(cards[15]).toHaveProperty('title', 'Small preview')
      for (const index of [16, 17]) {
        expect(cards[index]).toEqual({
          id: entries[index].id,
          uuid: template.uuid,
          notebookId,
          occurredAt: template.occurredAt.toISOString(),
          createdAt: template.createdAt.toISOString(),
          updatedAt: template.updatedAt.toISOString()
        })
      }
      expect(cards[18]).toHaveProperty('title', 'Small preview')
    } finally {
      metadata.mockRestore()
      read.mockRestore()
    }
  })

  it('单次 create/get/update 共用图片验证预算，原始新上传不会重复解码，旧图仍须验证', async () => {
    const service = new DiaryService()
    const budgetFactory = vi.spyOn(imageValidation, 'createImageValidationBudget')
    const validate = vi.spyOn(imageValidation, 'validateImageDataUrl')
    try {
      const created = await service.create(
        userId,
        {
          notebookId,
          occurredAt,
          markdown: '![a](draft-image://image0)\n![b](draft-image://image1)',
          images: [imageInput(0), imageInput(1)]
        },
        key
      )
      expect(budgetFactory).toHaveBeenCalledTimes(1)
      expect(validate).toHaveBeenCalledTimes(2)
      const createBudget = budgetFactory.mock.results[0].value
      expect(validate.mock.calls.every((call) => call[2] === createBudget)).toBe(true)

      budgetFactory.mockClear()
      validate.mockClear()
      expect((await service.get(userId, notebookId, created.id, key)).images).toHaveLength(2)
      expect(budgetFactory).toHaveBeenCalledTimes(1)
      expect(validate).toHaveBeenCalledTimes(2)
      const getBudget = budgetFactory.mock.results[0].value
      expect(getBudget).not.toBe(createBudget)
      expect(validate.mock.calls.every((call) => call[2] === getBudget)).toBe(true)

      budgetFactory.mockClear()
      validate.mockClear()
      const updated = await service.update(
        userId,
        {
          notebookId,
          diaryId: created.id,
          occurredAt,
          markdown: `${created.markdown}\n![c](draft-image://image2)`,
          images: [imageInput(2)]
        },
        key
      )
      expect(updated.images).toHaveLength(3)
      expect(budgetFactory).toHaveBeenCalledTimes(1)
      expect(validate).toHaveBeenCalledTimes(3)
      const updateBudget = budgetFactory.mock.results[0].value
      expect(updateBudget).not.toBe(getBudget)
      expect(validate.mock.calls.every((call) => call[2] === updateBudget)).toBe(true)
    } finally {
      validate.mockRestore()
      budgetFactory.mockRestore()
    }
  })

  it('微型共享像素预算覆盖整批图片与 update 新旧图，耗尽后不提交任何写入', async () => {
    const service = new DiaryService()
    const created = await service.create(
      userId,
      {
        notebookId,
        occurredAt,
        markdown: '![a](draft-image://image0)\n![b](draft-image://image1)',
        images: [imageInput(0), imageInput(1)]
      },
      key
    )
    const beforeDiaries = await Diary.count()
    const beforeImages = await DiaryImage.count()
    const originalFactory = imageValidation.createImageValidationBudget
    const budgetFactory = vi
      .spyOn(imageValidation, 'createImageValidationBudget')
      .mockImplementation((options) => originalFactory({ ...options, maxPixels: 1 }))
    try {
      await expect(
        service.create(
          userId,
          {
            notebookId,
            occurredAt,
            markdown: '![a](draft-image://image0)\n![b](draft-image://image1)',
            images: [imageInput(0), imageInput(1)]
          },
          key
        )
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      await expect(service.get(userId, notebookId, created.id, key)).rejects.toMatchObject({
        code: 'DIARY_DATA_DAMAGED'
      })
      await expect(
        service.update(
          userId,
          {
            notebookId,
            diaryId: created.id,
            occurredAt,
            markdown: `![old](${created.images[0].reference})\n![new](draft-image://image2)`,
            images: [imageInput(2)]
          },
          key
        )
      ).rejects.toMatchObject({ code: 'DIARY_DATA_DAMAGED' })
      expect(budgetFactory).toHaveBeenCalledTimes(3)
    } finally {
      budgetFactory.mockRestore()
    }
    expect(await Diary.count()).toBe(beforeDiaries)
    expect(await DiaryImage.count()).toBe(beforeImages)
    const restored = await service.get(userId, notebookId, created.id, key)
    expect(restored.markdown).toBe(created.markdown)
    expect(restored.images).toEqual(created.images)
  })

  it('新上传 UUID 与 MIME 相同但认证字节被替换时必须重新验证，失败回滚', async () => {
    const images = new DiaryImageRepository()
    const service = new DiaryService(new NotebookService(), new DiaryRepository(), images)
    const notebook = await Notebook.findByPk(notebookId, { logging: false })
    if (!notebook) throw new Error('测试日记本未创建')
    const beforeDiaries = await Diary.count()
    const beforeImages = await DiaryImage.count()
    const originalRead = images.findAllForDiary.bind(images)
    const read = vi
      .spyOn(images, 'findAllForDiary')
      .mockImplementation(async (diaryId, options) => {
        const stored = await originalRead(diaryId, options)
        const diary = await Diary.findByPk(diaryId, {
          transaction: options?.transaction,
          logging: false
        })
        if (!diary) throw new Error('测试日记未创建')
        const changed = Buffer.from(pngDataUrl.split(',')[1], 'base64')
        changed[0] = 0
        try {
          const encrypted = encryptBytes(
            changed,
            key,
            diaryImageAad(notebook.uuid, diary.uuid, stored[0].uuid, stored[0].mimeType)
          )
          stored[0].setDataValue('ciphertext', encrypted.ciphertext)
          stored[0].setDataValue('nonce', encrypted.nonce)
          stored[0].setDataValue('tag', encrypted.tag)
          return stored
        } finally {
          changed.fill(0)
        }
      })
    const validate = vi.spyOn(imageValidation, 'validateImageDataUrl')
    try {
      await expect(
        service.create(
          userId,
          {
            notebookId,
            occurredAt,
            markdown: '![x](draft-image://image0)',
            images: [imageInput(0)]
          },
          key
        )
      ).rejects.toMatchObject({ code: 'DIARY_DATA_DAMAGED' })
      expect(validate).toHaveBeenCalledTimes(2)
      expect(validate.mock.calls[0][2]).toBe(validate.mock.calls[1][2])
    } finally {
      read.mockRestore()
      validate.mockRestore()
    }
    expect(await Diary.count()).toBe(beforeDiaries)
    expect(await DiaryImage.count()).toBe(beforeImages)
  })

  it('插入图片后的会话取消会回滚日记和图片', async () => {
    const images = new DiaryImageRepository()
    const service = new DiaryService(new NotebookService(), new DiaryRepository(), images)
    const beforeDiaries = await Diary.count()
    const beforeImages = await DiaryImage.count()
    let active = true
    const guard = (): void => {
      if (!active) throw new AppError('Operation canceled.', 'NOTEBOOK_LOCKED')
    }
    const originalCreate = images.create.bind(images)
    const spy = vi.spyOn(images, 'create').mockImplementation(async (values, options) => {
      const image = await originalCreate(values, options)
      active = false
      return image
    })
    try {
      await expect(
        service.create(
          userId,
          {
            notebookId,
            occurredAt,
            markdown: '![x](draft-image://image0)',
            images: [imageInput(0)]
          },
          key,
          guard
        )
      ).rejects.toMatchObject({ code: 'NOTEBOOK_LOCKED' })
    } finally {
      spy.mockRestore()
    }
    expect(await Diary.count()).toBe(beforeDiaries)
    expect(await DiaryImage.count()).toBe(beforeImages)
  })

  it('解密后取消不会被列表的最佳努力预览 catch 吞掉', async () => {
    let calls = 0
    const guard = (): void => {
      if (++calls >= 8) throw new AppError('Operation canceled.', 'NOTEBOOK_LOCKED')
    }
    await expect(new DiaryService().list(userId, notebookId, key, guard)).rejects.toMatchObject({
      code: 'NOTEBOOK_LOCKED'
    })
  })

  it('创建日记本持久化后失效时事务回滚', async () => {
    const repository = new NotebookRepository()
    const service = new NotebookService(repository)
    const before = await Notebook.count()
    let active = true
    const originalCreate = repository.create.bind(repository)
    const spy = vi.spyOn(repository, 'create').mockImplementation(async (values, options) => {
      const notebook = await originalCreate(values, options)
      active = false
      return notebook
    })
    try {
      await expect(
        service.create(userId, 'Canceled notebook', 'notebook-password', () => {
          if (!active) throw new AppError('Operation canceled.', 'NOTEBOOK_LOCKED')
        })
      ).rejects.toMatchObject({ code: 'NOTEBOOK_LOCKED' })
    } finally {
      spy.mockRestore()
    }
    expect(await Notebook.count()).toBe(before)
  })
})
