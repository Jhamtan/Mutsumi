import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import type { Component } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { Router } from 'vue-router'
import type {
  IpcResponse,
  ItinerarySummaryDTO,
  PhotoWallExportResultDTO,
  PhotoWallPhotoDTO,
  PhotoWallStateDTO,
  UserDTO
} from '../../../src/common/types'
import { PHOTOWALL_BATCH_MAX_BYTES, PHOTOWALL_MAX_IMAGES } from '../../../src/common/photowall'
import { useUserStore } from '../../../src/renderer/src/store/user'
import { compressPhoto, readAsDataUrl } from '../../../src/renderer/src/utils/photo-wall'
import PhotoWall from '../../../src/renderer/src/views/photowall/PhotoWall.vue'
import PhotoWallView from '../../../src/renderer/src/views/photowall/PhotoWallView.vue'
import TripList from '../../../src/renderer/src/views/trip/TripList.vue'
import TripAbandoned from '../../../src/renderer/src/views/trip/TripAbandoned.vue'

vi.mock('../../../src/renderer/src/utils/photo-wall', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/src/utils/photo-wall')>()
  return {
    ...actual,
    compressPhoto: vi.fn<(file: File) => Promise<string>>(),
    readAsDataUrl: vi.fn<(file: File) => Promise<string>>(),
    hashImageDataUrl: vi.fn().mockResolvedValue(undefined)
  }
})

const ElDialogStub = defineComponent({
  props: { modelValue: { type: Boolean, default: false } },
  setup(props, { slots }) {
    return () => (props.modelValue ? h('div', { class: 'dialog-stub' }, slots.default?.()) : null)
  }
})

const user: UserDTO = {
  id: 1,
  name: '测试用户',
  email: 'test@example.test',
  createdAt: '2026-11-12T09:00:00.000Z',
  updatedAt: '2026-11-12T09:00:00.000Z'
}
const state: PhotoWallStateDTO = {
  minImages: 2,
  photoCount: 2,
  portrait: 'data:image/png;base64,YQ==',
  rounded: false
}
const photos: PhotoWallPhotoDTO[] = [
  { id: 1, dataUrl: 'data:image/png;base64,Yg==' },
  { id: 2, dataUrl: 'data:image/png;base64,Yw==' }
]
const trip: ItinerarySummaryDTO = {
  id: 5,
  uuid: '55555555-5555-4555-8555-555555555555',
  name: '测试行程',
  startTime: '2026-11-12T09:00:00.000Z',
  endTime: '2026-11-12T09:30:00.000Z',
  startPlaceName: '起点',
  endPlaceName: '终点',
  placeCount: 2,
  createdAt: '2026-11-12T09:00:00.000Z',
  updatedAt: '2026-11-12T09:00:00.000Z'
}
const newImage = 'data:image/png;base64,ZA=='
type TestApi = Pick<
  IAppApi,
  | 'getPhotoWall'
  | 'listPhotoWallPhotos'
  | 'listPhotoWallPhotoPage'
  | 'getPhotoWallLimits'
  | 'setPhotoWallLimits'
  | 'addPhotoWallPhotos'
  | 'setPhotoWallPortrait'
  | 'setPhotoWallMinImages'
  | 'setPhotoWallRounded'
  | 'deletePhotoWallPhoto'
  | 'clearPhotoWall'
  | 'exportPhotoWall'
  | 'listItineraries'
  | 'deleteItinerary'
  | 'listAbandonedItineraries'
  | 'restoreItinerary'
  | 'purgeItinerary'
>
let api: { [Key in keyof TestApi]: Mock<TestApi[Key]> }
const confirm = vi.fn<() => Promise<void>>()
const changes = ['页面切换', '账号变化', '同账号重新登录', '卸载'] as const
type Change = (typeof changes)[number]

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

async function mountPage(component: Component, path = '/photowall', loggedUser: UserDTO = user) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: ['/photowall', '/photowall/view', '/trips', '/trips/abandoned', '/other', '/login'].map(
      (route) => ({ path: route, component: { template: '<div />' } })
    )
  })
  await router.push(path)
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  const session = useUserStore(pinia)
  session.setUser(loggedUser)
  const wrapper = mount(component, {
    global: {
      plugins: [pinia, router],
      stubs: { ElDialog: ElDialogStub, ElSkeleton: true, ElInputNumber: true, ElSwitch: true }
    }
  })
  await flushPromises()
  return { wrapper, router, session }
}

async function invalidate(
  change: Change,
  page: {
    router: Router
    session: ReturnType<typeof useUserStore>
    wrapper: { unmount(): void }
  }
) {
  if (change === '页面切换') await page.router.push('/other')
  else if (change === '卸载') page.wrapper.unmount()
  else page.session.setUser({ ...user, id: change === '账号变化' ? 2 : user.id })
}

function selectFiles(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  input.dispatchEvent(new Event('change', { bubbles: true }))
}
function imageFile() {
  return new File(['测试图片'], 'photo.png', { type: 'image/png' })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('ElMessage', { success: vi.fn(), error: vi.fn(), warning: vi.fn() })
  vi.stubGlobal('ElMessageBox', { confirm })
  confirm.mockResolvedValue(undefined)
  vi.mocked(compressPhoto).mockResolvedValue(newImage)
  vi.mocked(readAsDataUrl).mockResolvedValue(newImage)
  api = {
    getPhotoWallLimits: vi.fn<IAppApi['getPhotoWallLimits']>().mockResolvedValue({
      success: true,
      data: { imageMaxBytes: 5 * 1024 * 1024, totalMaxBytes: 64 * 1024 * 1024, usedBytes: 0 }
    }),
    setPhotoWallLimits: vi
      .fn<IAppApi['setPhotoWallLimits']>()
      .mockImplementation(async (limits) => ({ success: true, data: { ...limits, usedBytes: 0 } })),
    listPhotoWallPhotoPage: vi
      .fn<IAppApi['listPhotoWallPhotoPage']>()
      .mockImplementation(async (options) => {
        const response = await api.listPhotoWallPhotos()
        if (!response.success) return { ...response, data: undefined }
        const all = response.data ?? []
        const remaining = all.filter((photo) => photo.id > (options?.afterId ?? 0))
        const items = remaining.slice(0, options?.pageSize ?? 10)
        return {
          success: true,
          data: {
            items,
            total: all.length,
            nextCursor: remaining.length > items.length ? items[items.length - 1].id : null
          }
        }
      }),
    getPhotoWall: vi
      .fn<IAppApi['getPhotoWall']>()
      .mockResolvedValue({ success: true, data: { ...state } }),
    listPhotoWallPhotos: vi
      .fn<IAppApi['listPhotoWallPhotos']>()
      .mockResolvedValue({ success: true, data: [...photos] }),
    addPhotoWallPhotos: vi
      .fn<IAppApi['addPhotoWallPhotos']>()
      .mockResolvedValue({ success: true, data: { added: 1, photoCount: 3 } }),
    setPhotoWallPortrait: vi
      .fn<IAppApi['setPhotoWallPortrait']>()
      .mockResolvedValue({ success: true, data: newImage }),
    setPhotoWallMinImages: vi
      .fn<IAppApi['setPhotoWallMinImages']>()
      .mockResolvedValue({ success: true, data: 2 }),
    setPhotoWallRounded: vi
      .fn<IAppApi['setPhotoWallRounded']>()
      .mockResolvedValue({ success: true, data: true }),
    deletePhotoWallPhoto: vi
      .fn<IAppApi['deletePhotoWallPhoto']>()
      .mockResolvedValue({ success: true, data: 1 }),
    clearPhotoWall: vi
      .fn<IAppApi['clearPhotoWall']>()
      .mockResolvedValue({ success: true, data: 0 }),
    exportPhotoWall: vi.fn<IAppApi['exportPhotoWall']>().mockResolvedValue({
      success: true,
      data: { canceled: false, filePath: 'memory-export.zip' }
    }),
    listItineraries: vi
      .fn<IAppApi['listItineraries']>()
      .mockResolvedValue({ success: true, data: [trip] }),
    deleteItinerary: vi
      .fn<IAppApi['deleteItinerary']>()
      .mockResolvedValue({ success: true, data: true }),
    listAbandonedItineraries: vi
      .fn<IAppApi['listAbandonedItineraries']>()
      .mockResolvedValue({ success: true, data: [trip] }),
    restoreItinerary: vi
      .fn<IAppApi['restoreItinerary']>()
      .mockResolvedValue({ success: true, data: true }),
    purgeItinerary: vi
      .fn<IAppApi['purgeItinerary']>()
      .mockResolvedValue({ success: true, data: true })
  }
  vi.stubGlobal('api', api)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('照片墙会话生命周期', () => {
  it.each(['页面切换', '账号变化', '同账号重新登录'] as const)(
    '%s后管理页的迟到成功不更新图片或可预览状态',
    async (change) => {
      const pending = deferred<IpcResponse<PhotoWallStateDTO>>()
      api.getPhotoWall.mockReturnValue(pending.promise)
      const page = await mountPage(PhotoWall)
      await invalidate(change, page)
      pending.resolve({ success: true, data: { ...state } })
      await flushPromises()
      expect(page.wrapper.findAll('img')).toHaveLength(0)
      expect(page.wrapper.get<HTMLButtonElement>('.preview-button').element.disabled).toBe(true)
      expect(ElMessage.error).not.toHaveBeenCalled()
    }
  )

  it.each(changes)('%s后预览加载的迟到失败不导航', async (change) => {
    const pending = deferred<IpcResponse<PhotoWallStateDTO>>()
    api.getPhotoWall.mockReturnValue(pending.promise)
    const page = await mountPage(PhotoWallView, '/photowall/view')
    await invalidate(change, page)
    const path = page.router.currentRoute.value.fullPath
    pending.resolve({ success: false, code: 'VALIDATION_ERROR', message: '旧加载失败' })
    await flushPromises()
    expect(page.router.currentRoute.value.fullPath).toBe(path)
    expect(ElMessage.error).not.toHaveBeenCalled()
  })

  it('Promise.all其中一项AUTH_REQUIRED已处理时不显示失败或二次导航', async () => {
    api.listPhotoWallPhotos.mockResolvedValue({ success: false, code: 'AUTH_REQUIRED' })
    const page = await mountPage(PhotoWallView, '/photowall/view')
    expect(page.session.isLoggedIn).toBe(false)
    expect(page.router.currentRoute.value.path).toBe('/login')
    expect(page.router.currentRoute.value.query.redirect).toBe('/photowall/view')
    expect(ElMessage.error).not.toHaveBeenCalled()
  })

  for (const upload of ['照片', '人物图片'] as const) {
    it.each(changes)(`%s后${upload}本地准备完成不发送旧上传`, async (change) => {
      const pending = deferred<string>()
      if (upload === '照片') vi.mocked(compressPhoto).mockReturnValue(pending.promise)
      else vi.mocked(readAsDataUrl).mockReturnValue(pending.promise)
      const page = await mountPage(PhotoWall)
      const inputs = page.wrapper.findAll<HTMLInputElement>('input[type="file"]')
      selectFiles(inputs[upload === '照片' ? 0 : 1].element, [imageFile(), imageFile()])
      await invalidate(change, page)
      pending.resolve(newImage)
      await flushPromises()
      expect(api.addPhotoWallPhotos).not.toHaveBeenCalled()
      expect(api.setPhotoWallPortrait).not.toHaveBeenCalled()
      expect(upload === '照片' ? compressPhoto : readAsDataUrl).toHaveBeenCalledTimes(1)
      expect(ElMessage.error).not.toHaveBeenCalled()
      expect(ElMessage.success).not.toHaveBeenCalled()
    })
  }

  for (const action of ['清空', '移除人物图片'] as const) {
    it.each(changes)(`%s后${action}的旧确认框不发送写入`, async (change) => {
      const pending = deferred<void>()
      confirm.mockReturnValue(pending.promise)
      const page = await mountPage(PhotoWall)
      const selector = action === '清空' ? '.upload-button.btn-secondary' : '.text-link'
      await page.wrapper.get(selector).trigger('click')
      expect(confirm).toHaveBeenCalledTimes(1)
      await invalidate(change, page)
      pending.resolve(undefined)
      await flushPromises()
      expect(api.clearPhotoWall).not.toHaveBeenCalled()
      expect(api.setPhotoWallPortrait).not.toHaveBeenCalled()
    })
  }

  it.each(changes)('%s后迟到的导出结果不弹窗或导航', async (change) => {
    const pending = deferred<IpcResponse<PhotoWallExportResultDTO>>()
    api.exportPhotoWall.mockReturnValue(pending.promise)
    const page = await mountPage(PhotoWallView, '/photowall/view')
    await page.wrapper.get('.wall-action').trigger('click')
    await invalidate(change, page)
    const path = page.router.currentRoute.value.fullPath
    pending.resolve({ success: true, data: { canceled: false, filePath: 'old-export.zip' } })
    await flushPromises()
    expect(page.router.currentRoute.value.fullPath).toBe(path)
    expect(page.wrapper.find('.dialog-stub').exists()).toBe(false)
    expect(api.exportPhotoWall).toHaveBeenCalledTimes(1)
    expect(ElMessage.error).not.toHaveBeenCalled()
  })

  it('新账号登录后旧AUTH_REQUIRED与迟到拒绝均不清空新身份', async () => {
    const pending = deferred<IpcResponse<PhotoWallStateDTO>>()
    const photoPending = deferred<IpcResponse<PhotoWallPhotoDTO[]>>()
    api.getPhotoWall.mockReturnValue(pending.promise)
    api.listPhotoWallPhotos.mockReturnValue(photoPending.promise)
    const page = await mountPage(PhotoWall)
    page.session.setUser({ ...user, id: 2 })
    pending.resolve({ success: false, code: 'AUTH_REQUIRED' })
    photoPending.reject(new Error('旧请求失败'))
    await flushPromises()
    expect(page.session.currentUser?.id).toBe(2)
    expect(page.router.currentRoute.value.fullPath).toBe('/photowall')
    expect(ElMessage.error).not.toHaveBeenCalled()
  })

  it.each(['OPERATION_CANCELLED', 'RATE_LIMITED', 'VALIDATION_ERROR'])(
    '新用户导出的%s不清除身份或自动重试',
    async (code) => {
      const page = await mountPage(PhotoWallView, '/photowall/view', { ...user, id: 2 })
      api.exportPhotoWall.mockResolvedValue({ success: false, code, message: '测试失败' })
      await page.wrapper.get('.wall-action').trigger('click')
      await flushPromises()
      expect(page.session.currentUser?.id).toBe(2)
      expect(page.session.isLoggedIn).toBe(true)
      expect(page.router.currentRoute.value.fullPath).toBe('/photowall/view')
      expect(page.wrapper.find('.dialog-stub').exists()).toBe(false)
      expect(api.exportPhotoWall).toHaveBeenCalledTimes(1)
      expect(ElMessage.error).toHaveBeenCalledWith('测试失败')
    }
  )

  it('当前会话导出成功才弹窗，用户取消保存对话框保持登录', async () => {
    const page = await mountPage(PhotoWallView, '/photowall/view')
    api.exportPhotoWall.mockResolvedValueOnce({ success: true, data: { canceled: true } })
    await page.wrapper.get('.wall-action').trigger('click')
    await flushPromises()
    expect(page.wrapper.find('.dialog-stub').exists()).toBe(false)
    expect(page.session.isLoggedIn).toBe(true)
    await page.wrapper.get('.wall-action').trigger('click')
    await flushPromises()
    expect(page.wrapper.get('.dialog-stub').text()).toContain('memory-export.zip')
    expect(ElMessage.error).not.toHaveBeenCalled()
  })

  it('账号变化后旧页面不再开始读取图片或发起新上传', async () => {
    const page = await mountPage(PhotoWall)
    page.session.setUser({ ...user, id: 2 })
    selectFiles(page.wrapper.get<HTMLInputElement>('input[type="file"]').element, [imageFile()])
    await flushPromises()
    expect(compressPhoto).not.toHaveBeenCalled()
    expect(api.addPhotoWallPhotos).not.toHaveBeenCalled()
    expect(page.session.currentUser?.id).toBe(2)
  })

  it('保留已有图片及批内图片去重，不重试写入', async () => {
    const page = await mountPage(PhotoWall)
    vi.mocked(compressPhoto)
      .mockResolvedValueOnce(photos[0].dataUrl)
      .mockResolvedValueOnce(newImage)
      .mockResolvedValueOnce(newImage)
    selectFiles(page.wrapper.get<HTMLInputElement>('input[type="file"]').element, [
      imageFile(),
      imageFile(),
      imageFile()
    ])
    await flushPromises()
    expect(api.addPhotoWallPhotos).toHaveBeenCalledExactlyOnceWith([newImage])
  })

  it.each(['数量', '原始字节'] as const)('超出%s预算在读取前整批拒绝', async (budget) => {
    const page = await mountPage(PhotoWall)
    const file = imageFile()
    if (budget === '原始字节')
      Object.defineProperty(file, 'size', { value: PHOTOWALL_BATCH_MAX_BYTES + 1 })
    const files =
      budget === '数量' ? Array.from({ length: PHOTOWALL_MAX_IMAGES + 1 }, () => file) : [file]
    selectFiles(page.wrapper.get<HTMLInputElement>('input[type="file"]').element, files)
    await flushPromises()
    expect(compressPhoto).not.toHaveBeenCalled()
    expect(api.addPhotoWallPhotos).not.toHaveBeenCalled()
    expect(ElMessage.error).toHaveBeenCalledTimes(1)
  })
})

describe('行程列表与废弃列表会话生命周期', () => {
  for (const abandoned of [false, true]) {
    it.each(changes)(`%s后${abandoned ? '永久删除' : '删除'}确认不发送旧写入`, async (change) => {
      const pending = deferred<void>()
      confirm.mockReturnValue(pending.promise)
      const page = await mountPage(
        abandoned ? TripAbandoned : TripList,
        abandoned ? '/trips/abandoned' : '/trips'
      )
      await page.wrapper.get(abandoned ? '.btn-danger' : '.delete-btn').trigger('click')
      await invalidate(change, page)
      pending.resolve(undefined)
      await flushPromises()
      expect(api.deleteItinerary).not.toHaveBeenCalled()
      expect(api.purgeItinerary).not.toHaveBeenCalled()
      expect(ElMessage.success).not.toHaveBeenCalled()
    })
  }

  it('账号变化后迟到恢复结果不提示成功或加载新账号数据', async () => {
    const pending = deferred<IpcResponse<boolean>>()
    api.restoreItinerary.mockReturnValue(pending.promise)
    const page = await mountPage(TripAbandoned, '/trips/abandoned')
    await page.wrapper.get('.btn-secondary').trigger('click')
    page.session.setUser({ ...user, id: 2 })
    pending.resolve({ success: true, data: true })
    await flushPromises()
    expect(api.listAbandonedItineraries).toHaveBeenCalledTimes(1)
    expect(ElMessage.success).not.toHaveBeenCalled()
    expect(page.session.currentUser?.id).toBe(2)
  })
})
