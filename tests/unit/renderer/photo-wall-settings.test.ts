import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { PhotoWallUsageDTO, PhotoWallPhotoDTO, UserDTO } from '../../../src/common/types'
import { useUserStore } from '../../../src/renderer/src/store/user'
import { useI18nStore } from '../../../src/renderer/src/store/i18n'
import {
  compressPhoto,
  hashImageDataUrl,
  readAsDataUrl
} from '../../../src/renderer/src/utils/photo-wall'
import PhotoWall from '../../../src/renderer/src/views/photowall/PhotoWall.vue'

vi.mock('../../../src/renderer/src/utils/photo-wall', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/src/utils/photo-wall')>()
  return {
    ...actual,
    compressPhoto: vi.fn<typeof actual.compressPhoto>(),
    readAsDataUrl: vi.fn<typeof actual.readAsDataUrl>(),
    hashImageDataUrl: vi.fn<typeof actual.hashImageDataUrl>()
  }
})

const ElInputNumberStub = defineComponent({
  inheritAttrs: false,
  props: {
    modelValue: { type: Number, default: 0 },
    min: Number,
    max: Number,
    precision: Number,
    step: { type: Number, default: 1 },
    disabled: { type: Boolean, default: false }
  },
  emits: ['update:modelValue', 'change'],
  setup(props, { attrs, emit }) {
    function update(event: Event) {
      if (props.disabled || !(event.target instanceof HTMLInputElement)) return
      emit('update:modelValue', event.target.valueAsNumber)
    }
    return () =>
      h('input', {
        ...attrs,
        type: 'number',
        value: props.modelValue,
        min: props.min,
        max: props.max,
        step: props.step,
        disabled: props.disabled,
        'data-precision': props.precision,
        onInput: update,
        onChange: (event: Event) => {
          update(event)
          if (!props.disabled && event.target instanceof HTMLInputElement)
            emit('change', event.target.valueAsNumber)
        }
      })
  }
})

const MiB = 1024 * 1024
const newImage = 'data:image/png;base64,ZA=='
const originalHash = 'a'.repeat(64)
const user: UserDTO = {
  id: 1,
  name: '测试用户',
  email: 'test@example.test',
  createdAt: '2026-11-12T09:00:00.000Z',
  updatedAt: '2026-11-12T09:00:00.000Z'
}
type TestApi = Pick<
  IAppApi,
  | 'getPhotoWall'
  | 'getPhotoWallLimits'
  | 'setPhotoWallLimits'
  | 'listPhotoWallPhotoPage'
  | 'listPhotoWallPhotos'
  | 'addPhotoWallPhotos'
  | 'setPhotoWallPortrait'
  | 'setPhotoWallMinImages'
  | 'setPhotoWallRounded'
  | 'deletePhotoWallPhoto'
  | 'clearPhotoWall'
>
let api: { [Key in keyof TestApi]: Mock<TestApi[Key]> }
let limits: PhotoWallUsageDTO
const messages = {
  success: vi.fn<(message: string) => void>(),
  error: vi.fn<(message: string) => void>(),
  warning: vi.fn<(message: string) => void>()
}
const mounted: Array<{ unmount(): void }> = []

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

async function mountPage() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: ['/photowall', '/other', '/login'].map((path) => ({
      path,
      component: { render: () => h('div') }
    }))
  })
  await router.push('/photowall')
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  const session = useUserStore(pinia)
  session.setUser(user)
  const i18n = useI18nStore(pinia)
  function mountCurrentPage() {
    const wrapper = mount(PhotoWall, {
      global: {
        plugins: [pinia, router],
        stubs: { ElInputNumber: ElInputNumberStub, ElSwitch: true, ElSkeleton: true }
      }
    })
    mounted.push(wrapper)
    return wrapper
  }
  const wrapper = mountCurrentPage()
  await flushPromises()
  return { wrapper, router, session, i18n, mountCurrentPage }
}

type Page = Awaited<ReturnType<typeof mountPage>>

async function editLimits(page: Page, image: number, total: number) {
  await page.wrapper
    .get<HTMLInputElement>('[data-testid="photo-single-limit"]')
    .setValue(String(image))
  await page.wrapper
    .get<HTMLInputElement>('[data-testid="photo-total-limit"]')
    .setValue(String(total))
}

function values(wrapper: Page['wrapper']) {
  return [
    wrapper.get<HTMLInputElement>('[data-testid="photo-single-limit"]').element.valueAsNumber,
    wrapper.get<HTMLInputElement>('[data-testid="photo-total-limit"]').element.valueAsNumber
  ]
}

function selectFiles(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function imageFile(type = 'image/png', size = 8): File {
  const bytes = new Uint8Array(size)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  return new File([bytes.buffer], type === 'image/jpeg' ? 'portrait.jpg' : 'photo.png', { type })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('ElMessage', messages)
  vi.stubGlobal('ElMessageBox', {
    confirm: vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  })
  vi.mocked(compressPhoto).mockResolvedValue(newImage)
  vi.mocked(readAsDataUrl).mockResolvedValue(newImage)
  vi.mocked(hashImageDataUrl).mockResolvedValue(undefined)
  limits = { imageMaxBytes: 5 * MiB, totalMaxBytes: 64 * MiB, usedBytes: 0 }
  api = {
    getPhotoWall: vi.fn<IAppApi['getPhotoWall']>().mockResolvedValue({
      success: true,
      data: { minImages: 10, photoCount: 0, portrait: null, rounded: false }
    }),
    getPhotoWallLimits: vi
      .fn<IAppApi['getPhotoWallLimits']>()
      .mockImplementation(async () => ({ success: true, data: { ...limits } })),
    setPhotoWallLimits: vi
      .fn<IAppApi['setPhotoWallLimits']>()
      .mockImplementation(async (payload) => {
        limits = { ...payload, usedBytes: limits.usedBytes }
        return { success: true, data: { ...limits } }
      }),
    listPhotoWallPhotoPage: vi.fn<IAppApi['listPhotoWallPhotoPage']>().mockResolvedValue({
      success: true,
      data: { items: [], total: 0, nextCursor: null }
    }),
    listPhotoWallPhotos: vi.fn<IAppApi['listPhotoWallPhotos']>(),
    addPhotoWallPhotos: vi
      .fn<IAppApi['addPhotoWallPhotos']>()
      .mockResolvedValue({ success: true, data: { added: 1, photoCount: 1 } }),
    setPhotoWallPortrait: vi
      .fn<IAppApi['setPhotoWallPortrait']>()
      .mockImplementation(async (dataUrl) => ({ success: true, data: dataUrl })),
    setPhotoWallMinImages: vi
      .fn<IAppApi['setPhotoWallMinImages']>()
      .mockResolvedValue({ success: true, data: 10 }),
    setPhotoWallRounded: vi
      .fn<IAppApi['setPhotoWallRounded']>()
      .mockResolvedValue({ success: true, data: false }),
    deletePhotoWallPhoto: vi
      .fn<IAppApi['deletePhotoWallPhoto']>()
      .mockResolvedValue({ success: true, data: 0 }),
    clearPhotoWall: vi.fn<IAppApi['clearPhotoWall']>().mockResolvedValue({ success: true, data: 0 })
  }
  vi.stubGlobal('api', api)
})
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.unstubAllGlobals()
})

describe('照片墙容量设置', () => {
  it('默认显示5/64MiB，可编辑输入保留label、id、边界和步长', async () => {
    const page = await mountPage()
    expect(values(page.wrapper)).toEqual([5, 64])
    for (const [id, min, max] of [
      ['photo-single-limit', '1', '10'],
      ['photo-total-limit', '64', '512']
    ] as const) {
      const input = page.wrapper.get<HTMLInputElement>(`#${id}`)
      expect(input.attributes('data-testid')).toBe(id)
      expect(page.wrapper.get(`label[for="${id}"]`).text()).not.toBe('')
      expect(input.attributes('min')).toBe(min)
      expect(input.attributes('max')).toBe(max)
      expect(input.attributes('step')).toBe('1')
      expect(input.attributes('data-precision')).toBe('0')
      expect(input.element.disabled).toBe(false)
    }
    expect(api.listPhotoWallPhotoPage).toHaveBeenCalledExactlyOnceWith({ afterId: 0, pageSize: 10 })
    expect(api.listPhotoWallPhotos).not.toHaveBeenCalled()
  })

  it('读取账号已保存10/256MiB及真实usage', async () => {
    limits = { imageMaxBytes: 10 * MiB, totalMaxBytes: 256 * MiB, usedBytes: 80 * MiB }
    const page = await mountPage()
    expect(values(page.wrapper)).toEqual([10, 256])
    expect(page.wrapper.get('[data-testid="photo-capacity-usage"]').text()).toContain('80.00')
    expect(page.wrapper.get('[data-testid="photo-capacity-usage"]').text()).toContain('256.00')
  })

  it('保存10/512MiB仅发送字节payload，成功后重新读取容量', async () => {
    const page = await mountPage()
    await editLimits(page, 10, 512)
    await page.wrapper.get('[data-testid="save-photo-limits"]').trigger('click')
    await flushPromises()
    expect(api.setPhotoWallLimits).toHaveBeenCalledExactlyOnceWith({
      imageMaxBytes: 10 * MiB,
      totalMaxBytes: 512 * MiB
    })
    expect(messages.success).toHaveBeenCalledExactlyOnceWith(page.i18n.t.photowall.capacitySaved)
    expect(api.getPhotoWallLimits).toHaveBeenCalledTimes(2)
    expect(values(page.wrapper)).toEqual([10, 512])
    expect(page.wrapper.get('[data-testid="photo-capacity-usage"]').text()).toContain('512.00')
  })

  it.each([
    [0, 64],
    [11, 64],
    [5.5, 64],
    [5, 63],
    [5, 513],
    [5, 64.5]
  ])('非法单图%s/总量%sMiB在发送前拒绝', async (image, total) => {
    const page = await mountPage()
    await editLimits(page, image, total)
    expect(values(page.wrapper)).toEqual([image, total])
    await page.wrapper.get('[data-testid="save-photo-limits"]').trigger('click')
    await flushPromises()
    expect(api.setPhotoWallLimits).not.toHaveBeenCalled()
    expect(messages.error).toHaveBeenCalledExactlyOnceWith(page.i18n.t.photowall.capacityRange)
    expect(messages.success).not.toHaveBeenCalled()
  })

  it('容量低于已使用空间时提示，不发保存请求', async () => {
    limits = { imageMaxBytes: 10 * MiB, totalMaxBytes: 256 * MiB, usedBytes: 80 * MiB }
    const page = await mountPage()
    await editLimits(page, 10, 64)
    await page.wrapper.get('[data-testid="save-photo-limits"]').trigger('click')
    await flushPromises()
    expect(api.setPhotoWallLimits).not.toHaveBeenCalled()
    expect(messages.error).toHaveBeenCalledExactlyOnceWith(page.i18n.t.photowall.capacityBelowUsage)
    expect(page.wrapper.get('[data-testid="photo-capacity-usage"]').text()).toContain('256.00')
  })

  it.each(['响应失败', '响应缺少data', '请求拒绝', '服务端容量不足'] as const)(
    '%s不伪保存成功或替换已保存usage',
    async (failure) => {
      const page = await mountPage()
      if (failure === '请求拒绝') api.setPhotoWallLimits.mockRejectedValue(new Error('保存失败'))
      else if (failure === '响应缺少data')
        api.setPhotoWallLimits.mockResolvedValue({ success: true })
      else
        api.setPhotoWallLimits.mockResolvedValue({
          success: false,
          code: failure === '服务端容量不足' ? 'PHOTOWALL_CAPACITY_EXCEEDED' : 'SAVE_FAILED'
        })
      await editLimits(page, 10, 512)
      await page.wrapper.get('[data-testid="save-photo-limits"]').trigger('click')
      await flushPromises()
      expect(api.setPhotoWallLimits).toHaveBeenCalledTimes(1)
      expect(messages.success).not.toHaveBeenCalled()
      expect(messages.error).toHaveBeenCalledExactlyOnceWith(
        failure === '服务端容量不足'
          ? page.i18n.t.photowall.capacityBelowUsage
          : page.i18n.t.photowall.capacitySaveFail
      )
      expect(api.getPhotoWallLimits).toHaveBeenCalledTimes(1)
      expect(page.wrapper.get('[data-testid="photo-capacity-usage"]').text()).toContain('64.00')
      expect(
        page.wrapper.get<HTMLButtonElement>('[data-testid="save-photo-limits"]').element.disabled
      ).toBe(false)
    }
  )

  it('容量尚未读取时禁用输入与保存，不发送写请求', async () => {
    const pending = deferred<Awaited<ReturnType<IAppApi['getPhotoWallLimits']>>>()
    api.getPhotoWallLimits.mockReturnValue(pending.promise)
    const page = await mountPage()
    expect(values(page.wrapper)).toEqual([5, 64])
    expect(page.wrapper.get<HTMLInputElement>('#photo-single-limit').element.disabled).toBe(true)
    expect(page.wrapper.get<HTMLInputElement>('#photo-total-limit').element.disabled).toBe(true)
    await page.wrapper.get('[data-testid="save-photo-limits"]').trigger('click')
    expect(api.setPhotoWallLimits).not.toHaveBeenCalled()
    pending.resolve({
      success: true,
      data: { imageMaxBytes: 10 * MiB, totalMaxBytes: 256 * MiB, usedBytes: 0 }
    })
    await flushPromises()
    expect(values(page.wrapper)).toEqual([10, 256])
  })

  it('保存中禁用再次保存，不重复发请求', async () => {
    const pending = deferred<Awaited<ReturnType<IAppApi['setPhotoWallLimits']>>>()
    api.setPhotoWallLimits.mockReturnValue(pending.promise)
    const page = await mountPage()
    await editLimits(page, 10, 512)
    await page.wrapper.get('[data-testid="save-photo-limits"]').trigger('click')
    expect(
      page.wrapper.get<HTMLButtonElement>('[data-testid="save-photo-limits"]').element.disabled
    ).toBe(true)
    await page.wrapper.get('[data-testid="save-photo-limits"]').trigger('click')
    expect(api.setPhotoWallLimits).toHaveBeenCalledTimes(1)
    pending.resolve({ success: false })
    await flushPromises()
  })

  for (const change of ['页面切换', '账号变化', '同账号重新登录'] as const) {
    it.each(['迟到成功', '迟到AUTH_REQUIRED', '迟到拒绝'] as const)(
      `${change}后的%s不污染新页面或新session`,
      async (outcome) => {
        const pending = deferred<Awaited<ReturnType<IAppApi['setPhotoWallLimits']>>>()
        api.setPhotoWallLimits.mockReturnValue(pending.promise)
        const page = await mountPage()
        await editLimits(page, 10, 512)
        await page.wrapper.get('[data-testid="save-photo-limits"]').trigger('click')
        if (change === '页面切换') await page.router.push('/other')
        else page.session.setUser({ ...user, id: change === '账号变化' ? 2 : 1 })
        limits = { imageMaxBytes: 7 * MiB, totalMaxBytes: 128 * MiB, usedBytes: 2 * MiB }
        const current = page.mountCurrentPage()
        await flushPromises()
        expect(values(current)).toEqual([7, 128])
        const readCount = api.getPhotoWallLimits.mock.calls.length
        const currentPath = page.router.currentRoute.value.fullPath
        if (outcome === '迟到成功')
          pending.resolve({
            success: true,
            data: { imageMaxBytes: 10 * MiB, totalMaxBytes: 512 * MiB, usedBytes: 0 }
          })
        else if (outcome === '迟到AUTH_REQUIRED')
          pending.resolve({ success: false, code: 'AUTH_REQUIRED' })
        else pending.reject(new Error('旧保存失败'))
        await flushPromises()
        expect(values(current)).toEqual([7, 128])
        expect(current.get('[data-testid="photo-capacity-usage"]').text()).toContain('128.00')
        expect(
          current.get<HTMLButtonElement>('[data-testid="save-photo-limits"]').element.disabled
        ).toBe(false)
        expect(api.getPhotoWallLimits).toHaveBeenCalledTimes(readCount)
        expect(page.session.currentUser?.id).toBe(change === '账号变化' ? 2 : 1)
        expect(page.session.isLoggedIn).toBe(true)
        expect(page.router.currentRoute.value.fullPath).toBe(currentPath)
        expect(messages.success).not.toHaveBeenCalled()
        expect(messages.error).not.toHaveBeenCalled()
      }
    )
  }
})

describe('照片墙上传使用当前容量及人物图说明', () => {
  it('读取保存的10MiB限额后上传向compressPhoto传当前字节预算', async () => {
    limits = { imageMaxBytes: 10 * MiB, totalMaxBytes: 256 * MiB, usedBytes: 0 }
    const page = await mountPage()
    const file = imageFile()
    selectFiles(page.wrapper.get<HTMLInputElement>('input[type="file"][multiple]').element, [file])
    await flushPromises()
    expect(compressPhoto).toHaveBeenCalledExactlyOnceWith(file, 10 * MiB)
    expect(api.addPhotoWallPhotos).toHaveBeenCalledExactlyOnceWith([newImage])
  })

  it('修改未保存的输入不改变上传预算', async () => {
    const page = await mountPage()
    await editLimits(page, 10, 512)
    const file = imageFile()
    selectFiles(page.wrapper.get<HTMLInputElement>('input[type="file"][multiple]').element, [file])
    await flushPromises()
    expect(compressPhoto).toHaveBeenCalledExactlyOnceWith(file, 5 * MiB)
    expect(api.setPhotoWallLimits).not.toHaveBeenCalled()
  })

  it('使用预览的原图hash去重，即使缩略图URL与待传原图不同也不上传', async () => {
    const photo: PhotoWallPhotoDTO = {
      id: 1,
      dataUrl: 'data:image/png;base64,YQ==',
      sourceHash: originalHash
    }
    api.listPhotoWallPhotoPage.mockResolvedValue({
      success: true,
      data: { items: [photo], total: 1, nextCursor: null }
    })
    api.getPhotoWall.mockResolvedValue({
      success: true,
      data: { minImages: 10, photoCount: 1, portrait: null, rounded: false }
    })
    vi.mocked(hashImageDataUrl).mockResolvedValue(originalHash)
    const page = await mountPage()
    selectFiles(page.wrapper.get<HTMLInputElement>('input[type="file"][multiple]').element, [
      imageFile()
    ])
    await flushPromises()
    expect(hashImageDataUrl).toHaveBeenCalledExactlyOnceWith(newImage)
    expect(api.addPhotoWallPhotos).not.toHaveBeenCalled()
    expect(messages.warning).toHaveBeenCalledExactlyOnceWith(page.i18n.t.photowall.allDuplicates)
    expect(page.wrapper.get('img').attributes('src')).toBe(photo.dataUrl)
    expect(api.listPhotoWallPhotos).not.toHaveBeenCalled()
  })

  it.each(['页面切换', '账号变化'] as const)(
    '%s发生于原图hash计算时，不继续上传',
    async (change) => {
      const pending = deferred<string | undefined>()
      vi.mocked(hashImageDataUrl).mockReturnValue(pending.promise)
      const page = await mountPage()
      selectFiles(page.wrapper.get<HTMLInputElement>('input[type="file"][multiple]').element, [
        imageFile(),
        imageFile()
      ])
      await flushPromises()
      expect(hashImageDataUrl).toHaveBeenCalledTimes(1)
      if (change === '页面切换') await page.router.push('/other')
      else page.session.setUser({ ...user, id: 2 })
      pending.resolve(originalHash)
      await flushPromises()
      expect(compressPhoto).toHaveBeenCalledTimes(1)
      expect(api.addPhotoWallPhotos).not.toHaveBeenCalled()
      expect(messages.success).not.toHaveBeenCalled()
      expect(messages.error).not.toHaveBeenCalled()
    }
  )

  it('超过20MiB人物图在读取、压缩及IPC之前拒绝', async () => {
    const page = await mountPage()
    const file = imageFile('image/png', 20 * MiB + 1)
    selectFiles(page.wrapper.get<HTMLInputElement>('input[type="file"]:not([multiple])').element, [
      file
    ])
    await flushPromises()
    expect(readAsDataUrl).not.toHaveBeenCalled()
    expect(compressPhoto).not.toHaveBeenCalled()
    expect(api.setPhotoWallPortrait).not.toHaveBeenCalled()
    expect(messages.error).toHaveBeenCalledExactlyOnceWith(page.i18n.t.photowall.portraitTooLarge)
  })

  it('恰好20MiB人物图只读取原图，不应用单图照片压缩预算', async () => {
    const page = await mountPage()
    const file = imageFile('image/png', 20 * MiB)
    selectFiles(page.wrapper.get<HTMLInputElement>('input[type="file"]:not([multiple])').element, [
      file
    ])
    await flushPromises()
    expect(readAsDataUrl).toHaveBeenCalledExactlyOnceWith(file)
    expect(compressPhoto).not.toHaveBeenCalled()
    expect(api.setPhotoWallPortrait).toHaveBeenCalledExactlyOnceWith(newImage)
  })

  it('JPEG人物图原样保存，不自动去除白底或调用照片压缩', async () => {
    const jpeg = 'data:image/jpeg;base64,/9j/4AA='
    vi.mocked(readAsDataUrl).mockResolvedValue(jpeg)
    const page = await mountPage()
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer], 'portrait.jpg', {
      type: 'image/jpeg'
    })
    selectFiles(page.wrapper.get<HTMLInputElement>('input[type="file"]:not([multiple])').element, [
      file
    ])
    await flushPromises()
    expect(readAsDataUrl).toHaveBeenCalledExactlyOnceWith(file)
    expect(api.setPhotoWallPortrait).toHaveBeenCalledExactlyOnceWith(jpeg)
    expect(compressPhoto).not.toHaveBeenCalled()
  })

  it('人物图说明明确竖向、透明PNG/WebP、16:9及JPEG白底不会自动去除', async () => {
    const page = await mountPage()
    const guidance = page.wrapper.get('[data-testid="portrait-guidance"]').text()
    const section = page.wrapper.get('[data-testid="portrait-guidance"]').element.closest('section')
    expect(guidance).toMatch(/竖向|竖版|vertical|portrait/i)
    expect(section?.textContent).toMatch(/透明|transparent/i)
    expect(section?.textContent).toMatch(/PNG/i)
    expect(section?.textContent).toMatch(/WebP/i)
    expect(section?.textContent).toMatch(/16[:：]9/)
    expect(section?.textContent).toMatch(/JPEG|JPG/i)
    expect(section?.textContent).toMatch(/白底|白色背景|white background/i)
    expect(section?.textContent).toMatch(/不自动|不会自动|不会.*去|not.*remov|cannot.*remov/i)
  })
})
