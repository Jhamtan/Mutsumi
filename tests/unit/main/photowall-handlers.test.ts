import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcResponse } from '../../../src/common/types'
import { createIpcEvent } from '../helpers/ipc-event'
import { setSession } from '../../../src/main/ipc/security'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  fromWebContents: vi.fn(),
  showSaveDialog: vi.fn(),
  getState: vi.fn(),
  listPhotos: vi.fn(),
  listPhotoPage: vi.fn(),
  getUsage: vi.fn(),
  getLimits: vi.fn(),
  setLimits: vi.fn(),
  setMinImages: vi.fn(),
  addPhotos: vi.fn(),
  setPortrait: vi.fn(),
  setRounded: vi.fn(),
  deletePhoto: vi.fn(),
  clearPhotos: vi.fn(),
  exportWallpaper: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.handle },
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  dialog: { showSaveDialog: mocks.showSaveDialog }
}))
vi.mock('../../../src/main/logger', () => ({ default: { error: vi.fn() } }))
vi.mock('../../../src/main/services/PhotoWallService', () => ({
  default: class {
    getState = mocks.getState
    listPhotos = mocks.listPhotos
    listPhotoPage = mocks.listPhotoPage
    getUsage = mocks.getUsage
    setMinImages = mocks.setMinImages
    addPhotos = mocks.addPhotos
    setPortrait = mocks.setPortrait
    setRounded = mocks.setRounded
    deletePhoto = mocks.deletePhoto
    clearPhotos = mocks.clearPhotos
    exportWallpaper = mocks.exportWallpaper
  }
}))

vi.mock('../../../src/main/services/PhotoWallLimitsService', () => ({
  default: class {
    get = mocks.getLimits
    set = mocks.setLimits
  }
}))

import { registerPhotoWallHandlers } from '../../../src/main/ipc/handlers/photowall-handlers'
import { AppError } from '../../../src/main/errors'

/**
 * Tests photo wall IPC handlers: channel registration, session gating, and
 * passing the main-process identity plus validated payloads to the service.
 */
type Handler = (event: IpcMainInvokeEvent, args: unknown) => Promise<IpcResponse<unknown>>
const handlers = new Map<string, Handler>()

const dataUrl = 'data:image/jpeg;base64,AAAA'
const defaultLimits = { imageMaxBytes: 5 * 1024 * 1024, totalMaxBytes: 64 * 1024 * 1024 }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.getLimits.mockReturnValue(defaultLimits)
  mocks.getUsage.mockResolvedValue(0)
  mocks.setLimits.mockImplementation((_userId, limits) => limits)
  handlers.clear()
  mocks.handle.mockImplementation((channel: string, handler: Handler) =>
    handlers.set(channel, handler)
  )
  registerPhotoWallHandlers()
})

function invoke(channel: string, event: IpcMainInvokeEvent, args: unknown = undefined) {
  return handlers.get(channel)!(event, args)
}

function authenticatedEvent(userId = 42) {
  const source = createIpcEvent()
  setSession(source.event, userId)
  return source
}

describe('photo wall handlers', () => {
  it('registers every photo wall channel', () => {
    expect([...handlers.keys()]).toEqual([
      'photowall:get',
      'photowall:photos',
      'photowall:photo-page',
      'photowall:get-limits',
      'photowall:set-limits',
      'photowall:set-min-images',
      'photowall:add-photos',
      'photowall:set-portrait',
      'photowall:set-rounded',
      'photowall:delete-photo',
      'photowall:clear',
      'photowall:export'
    ])
  })

  it('requires authentication before any service access', async () => {
    const unauthenticated = createIpcEvent().event
    expect((await invoke('photowall:get', unauthenticated)).code).toBe('AUTH_REQUIRED')
    expect(mocks.getState).not.toHaveBeenCalled()
  })

  it('新容量和分页通道要求认证，拒绝伪造账号、路径及超硬上限', async () => {
    const unauthenticated = createIpcEvent().event
    for (const [channel, payload] of [
      ['photowall:get-limits', undefined],
      ['photowall:set-limits', defaultLimits],
      ['photowall:photo-page', {}]
    ] as const) {
      expect((await invoke(channel, unauthenticated, payload)).code).toBe('AUTH_REQUIRED')
    }
    expect(mocks.getLimits).not.toHaveBeenCalled()
    expect(mocks.getUsage).not.toHaveBeenCalled()
    expect(mocks.listPhotoPage).not.toHaveBeenCalled()
    const source = authenticatedEvent()
    for (const limits of [
      { ...defaultLimits, userId: 99 },
      { ...defaultLimits, path: 'private' },
      { ...defaultLimits, totalMaxBytes: 513 * 1024 * 1024 },
      { ...defaultLimits, imageMaxBytes: 11 * 1024 * 1024 }
    ]) {
      expect((await invoke('photowall:set-limits', source.event, limits)).code).toBe(
        'INVALID_INPUT'
      )
    }
    expect(mocks.setLimits).not.toHaveBeenCalled()
    expect(mocks.getUsage).not.toHaveBeenCalled()
  })

  it('uses the main-process session identity and passes validated payloads', async () => {
    const source = authenticatedEvent(42)
    mocks.getState.mockResolvedValue({
      minImages: 10,
      photoCount: 0,
      portrait: null,
      rounded: false
    })
    mocks.addPhotos.mockResolvedValue({ added: 2, photoCount: 2 })
    mocks.setPortrait.mockResolvedValue(dataUrl)
    mocks.setMinImages.mockResolvedValue(20)
    mocks.setRounded.mockResolvedValue(true)

    await invoke('photowall:get', source.event)
    expect(mocks.getState).toHaveBeenCalledExactlyOnceWith(42, expect.any(Function), defaultLimits)

    await invoke('photowall:add-photos', source.event, { dataUrls: [dataUrl, dataUrl] })
    expect(mocks.addPhotos).toHaveBeenCalledExactlyOnceWith(
      42,
      [dataUrl, dataUrl],
      expect.any(Function),
      defaultLimits
    )

    await invoke('photowall:set-portrait', source.event, { dataUrl })
    expect(mocks.setPortrait).toHaveBeenCalledExactlyOnceWith(
      42,
      dataUrl,
      expect.any(Function),
      defaultLimits
    )

    await invoke('photowall:set-rounded', source.event, { rounded: true })
    expect(mocks.setRounded).toHaveBeenCalledExactlyOnceWith(42, true, expect.any(Function))

    await invoke('photowall:set-min-images', source.event, { minImages: 20 })
    expect(mocks.setMinImages).toHaveBeenCalledExactlyOnceWith(42, 20, expect.any(Function))
  })

  it('rejects invalid payloads before service access', async () => {
    const source = authenticatedEvent(42)
    expect((await invoke('photowall:set-min-images', source.event, { minImages: 0 })).code).toBe(
      'INVALID_INPUT'
    )
    expect((await invoke('photowall:add-photos', source.event, { dataUrls: [] })).code).toBe(
      'INVALID_INPUT'
    )
    expect((await invoke('photowall:set-rounded', source.event, { rounded: 'yes' })).code).toBe(
      'INVALID_INPUT'
    )
    expect(mocks.setMinImages).not.toHaveBeenCalled()
    expect(mocks.addPhotos).not.toHaveBeenCalled()
    expect(mocks.setRounded).not.toHaveBeenCalled()
  })

  it('normalizes unexpected service failures without leaking details', async () => {
    const source = authenticatedEvent()
    mocks.getState.mockRejectedValue(new Error('private SQL and file paths'))
    const response = await invoke('photowall:get', source.event)
    expect(response).toMatchObject({ success: false, code: 'INTERNAL_ERROR' })
    expect(JSON.stringify(response)).not.toContain('private')
  })

  it('exports the wallpaper through a save dialog', async () => {
    const source = authenticatedEvent(42)
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: 'C:/out/wallpaper.zip' })
    mocks.exportWallpaper.mockResolvedValue({ photoCount: 5 })

    expect(await invoke('photowall:export', source.event)).toEqual({
      success: true,
      data: { canceled: false, filePath: 'C:/out/wallpaper.zip', photoCount: 5 }
    })
    expect(mocks.exportWallpaper).toHaveBeenCalledExactlyOnceWith(
      42,
      'C:/out/wallpaper.zip',
      expect.any(Function),
      defaultLimits
    )
  })

  it('读取可信限额和元数据用量，分页不接受前端账号或路径', async () => {
    const source = authenticatedEvent(51)
    mocks.getUsage.mockResolvedValue(123)
    expect(await invoke('photowall:get-limits', source.event)).toEqual({
      success: true,
      data: { ...defaultLimits, usedBytes: 123 }
    })
    expect(mocks.getLimits).toHaveBeenCalledWith(51, expect.any(Function))
    expect(mocks.getUsage).toHaveBeenCalledWith(51, expect.any(Function))
    mocks.listPhotoPage.mockResolvedValue({ items: [], total: 0, nextCursor: null })
    await invoke('photowall:photo-page', source.event, {})
    expect(mocks.listPhotoPage).toHaveBeenCalledWith(
      51,
      { afterId: 0, pageSize: 10 },
      expect.any(Function),
      defaultLimits
    )
    for (const payload of [{ afterId: -1 }, { pageSize: 11 }, { userId: 99 }, { path: 'private' }])
      expect((await invoke('photowall:photo-page', source.event, payload)).code).toBe(
        'INVALID_INPUT'
      )
    expect(mocks.listPhotoPage).toHaveBeenCalledTimes(1)
  })

  it('降低总容量至用量以下拒绝且不写入配置', async () => {
    const source = authenticatedEvent()
    mocks.getUsage.mockResolvedValue(65 * 1024 * 1024)
    expect((await invoke('photowall:set-limits', source.event, defaultLimits)).code).toBe(
      'PHOTOWALL_CAPACITY_EXCEEDED'
    )
    expect(mocks.setLimits).not.toHaveBeenCalled()
    const larger = { imageMaxBytes: 6 * 1024 * 1024, totalMaxBytes: 128 * 1024 * 1024 }
    expect(await invoke('photowall:set-limits', source.event, larger)).toEqual({
      success: true,
      data: { ...larger, usedBytes: 65 * 1024 * 1024 }
    })
    expect(mocks.setLimits).toHaveBeenCalledWith(42, larger, expect.any(Function))
  })

  it('容量设置共享上传 FIFO，撤销后不保存也不继承新账号身份', async () => {
    const source = authenticatedEvent()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    mocks.addPhotos.mockImplementation(async () => {
      entered()
      await gate
      return { added: 1, photoCount: 1 }
    })
    const upload = invoke('photowall:add-photos', source.event, { dataUrls: [dataUrl] })
    await ready
    const setting = invoke('photowall:set-limits', source.event, defaultLimits)
    expect(mocks.getUsage).not.toHaveBeenCalled()
    setSession(source.event, 99)
    release()
    await upload
    expect((await setting).success).toBe(false)
    expect(mocks.setLimits).not.toHaveBeenCalled()
  })

  it('用量 await 期间会话失效和同步保存失败均不伪成功', async () => {
    const source = authenticatedEvent()
    mocks.getUsage.mockImplementationOnce(async () => {
      setSession(source.event, 99)
      return 0
    })
    expect((await invoke('photowall:set-limits', source.event, defaultLimits)).success).toBe(false)
    expect(mocks.setLimits).not.toHaveBeenCalled()
    const fresh = authenticatedEvent()
    mocks.setLimits.mockImplementationOnce(() => {
      throw new Error('private disk path')
    })
    expect(await invoke('photowall:set-limits', fresh.event, defaultLimits)).toMatchObject({
      success: false,
      code: 'INTERNAL_ERROR'
    })
    mocks.addPhotos.mockRejectedValueOnce(new AppError('Image is too large.', 'IMAGE_TOO_LARGE'))
    expect((await invoke('photowall:add-photos', fresh.event, { dataUrls: [dataUrl] })).code).toBe(
      'IMAGE_TOO_LARGE'
    )
    expect((await invoke('photowall:get-limits', fresh.event)).success).toBe(true)
  })

  it('returns cancellation without exporting', async () => {
    const source = authenticatedEvent(42)
    mocks.showSaveDialog.mockResolvedValue({ canceled: true })
    expect(await invoke('photowall:export', source.event)).toEqual({
      success: true,
      data: { canceled: true }
    })
    expect(mocks.exportWallpaper).not.toHaveBeenCalled()
  })
})
