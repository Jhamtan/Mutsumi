import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { PhotoWallPhotoDTO, UserDTO } from '../../../src/common/types'
import { useUserStore } from '../../../src/renderer/src/store/user'
import { useSessionOperation } from '../../../src/renderer/src/composables/useSessionOperation'
import type { SessionOperation } from '../../../src/renderer/src/composables/useSessionOperation'
import {
  compressPhoto,
  dataUrlBytes,
  detectImageMime,
  hashImageDataUrl,
  PhotoWallImageError,
  readAsDataUrl
} from '../../../src/renderer/src/utils/photo-wall'
import { loadPhotoWallPreview } from '../../../src/renderer/src/utils/photo-wall-preview'

const MiB = 1024 * 1024
const signatures = {
  jpeg: [0xff, 0xd8, 0xff, 0xe0, 0, 0],
  png: [137, 80, 78, 71, 13, 10, 26, 10],
  gif87: Array.from('GIF87a', (char) => char.charCodeAt(0)),
  gif89: Array.from('GIF89a', (char) => char.charCodeAt(0)),
  webp: Array.from('RIFF0000WEBP', (char) => char.charCodeAt(0))
}
const user: UserDTO = {
  id: 1,
  name: '测试用户',
  email: 'test@example.test',
  createdAt: '2026-11-12T09:00:00.000Z',
  updatedAt: '2026-11-12T09:00:00.000Z'
}
const mounted: Array<{ unmount(): void }> = []

type PageResponse = Awaited<ReturnType<IAppApi['listPhotoWallPhotoPage']>>

function imageFile(
  signature: number[],
  name = 'photo.bin',
  type = '',
  size = signature.length
): File {
  const bytes = new Uint8Array(size)
  bytes.set(signature)
  return new File([bytes.buffer], name, { type })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function previewSession() {
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
  let operation!: SessionOperation
  const wrapper = mount(
    defineComponent({
      setup() {
        operation = useSessionOperation().capture()
        return () => h('div')
      }
    }),
    { global: { plugins: [pinia, router] } }
  )
  mounted.push(wrapper)
  return { operation, router, session }
}

function thumbnail(id: number): PhotoWallPhotoDTO {
  return {
    id,
    dataUrl: 'data:image/png;base64,YQ==',
    sourceHash: id.toString(16).padStart(64, '0')
  }
}

function page(items: PhotoWallPhotoDTO[], total: number, nextCursor: number | null): PageResponse {
  return { success: true, data: { items, total, nextCursor } }
}

function previewApi() {
  const api = {
    listPhotoWallPhotoPage: vi.fn<IAppApi['listPhotoWallPhotoPage']>(),
    listPhotoWallPhotos: vi.fn<IAppApi['listPhotoWallPhotos']>()
  } satisfies Pick<IAppApi, 'listPhotoWallPhotoPage' | 'listPhotoWallPhotos'>
  vi.stubGlobal('api', api)
  return api
}

beforeEach(() => {
  vi.stubGlobal('ElMessage', {
    error: vi.fn<(message: string) => void>(),
    success: vi.fn<(message: string) => void>(),
    warning: vi.fn<(message: string) => void>()
  })
})
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('照片墙真实 File/FileReader 格式与预算', () => {
  it.each([
    ['jpeg', 'image/jpeg'],
    ['png', 'image/png'],
    ['gif87', 'image/gif'],
    ['gif89', 'image/gif'],
    ['webp', 'image/webp']
  ] as const)('%s由签名识别，读取完整字节而非文件后缀', async (format, mime) => {
    const file = imageFile(signatures[format], 'misleading.txt', 'text/plain')
    expect(detectImageMime(new Uint8Array(signatures[format]))).toBe(mime)
    const result = await readAsDataUrl(file)
    expect(result).toBe(`data:${mime};base64,${btoa(String.fromCharCode(...signatures[format]))}`)
    expect(dataUrlBytes(result)).toBe(file.size)
  })

  it('JPEG字节、2.png文件名及PNG声明归一为image/jpeg且保留字节', async () => {
    const file = imageFile(signatures.jpeg, '2.png', 'image/png')
    expect(await readAsDataUrl(file)).toBe(
      `data:image/jpeg;base64,${btoa(String.fromCharCode(...signatures.jpeg))}`
    )
  })

  it.each(['', 'image/jpeg'])('PNG的File.type为%s仍归一为image/png', async (type) => {
    const file = imageFile(signatures.png, 'wrong.jpg', type)
    expect(await readAsDataUrl(file)).toBe(
      `data:image/png;base64,${btoa(String.fromCharCode(...signatures.png))}`
    )
  })

  it.each([
    ['SVG', '<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
    ['HTML', '<html><body>不是图片</body></html>'],
    ['随机字节', '\u0000\u0001\u0002\u0003随机']
  ])('%s即使伪造.png后缀及image/png也拒绝', async (_name, content) => {
    const file = new File([content], 'fake.png', { type: 'image/png' })
    const read = vi.spyOn(FileReader.prototype, 'readAsDataURL')
    await expect(readAsDataUrl(file)).rejects.toMatchObject({ reason: 'unsupported' })
    expect(read).not.toHaveBeenCalled()
    expect(detectImageMime(new Uint8Array([0, 1, 2, 3]))).toBeUndefined()
  })

  it('不完整签名不被识别', () => {
    expect(detectImageMime(new Uint8Array(signatures.png.slice(0, 7)))).toBeUndefined()
    expect(detectImageMime(new Uint8Array([0xff, 0xd8]))).toBeUndefined()
    expect(detectImageMime(new Uint8Array())).toBeUndefined()
    expect(
      detectImageMime(new Uint8Array(Array.from('RIFF0000WAVE', (char) => char.charCodeAt(0))))
    ).toBeUndefined()
  })

  it('超过20MiB的人物图在任何FileReader读取之前拒绝', async () => {
    const header = vi.spyOn(FileReader.prototype, 'readAsArrayBuffer')
    const content = vi.spyOn(FileReader.prototype, 'readAsDataURL')
    const file = imageFile(signatures.png, 'portrait.png', 'image/png', 20 * MiB + 1)
    await expect(readAsDataUrl(file)).rejects.toBeInstanceOf(PhotoWallImageError)
    await expect(readAsDataUrl(file)).rejects.toMatchObject({ reason: 'file-too-large' })
    expect(header).not.toHaveBeenCalled()
    expect(content).not.toHaveBeenCalled()
  })

  it.each([5 * MiB + 1, 10 * MiB])(
    '指定10MiB预算时%s字节保留原图，不创建Image或canvas',
    async (size) => {
      const image = vi.fn<() => void>()
      vi.stubGlobal('Image', image)
      const create = vi.spyOn(document, 'createElement')
      const file = imageFile(signatures.jpeg, 'original.png', 'image/png', size)
      const result = await compressPhoto(file, 10 * MiB)
      expect(result).toBe(await readAsDataUrl(file))
      expect(result.startsWith('data:image/jpeg;base64,')).toBe(true)
      expect(dataUrlBytes(result)).toBe(size)
      expect(atob(result.slice(result.indexOf(',') + 1)).slice(0, signatures.jpeg.length)).toBe(
        String.fromCharCode(...signatures.jpeg)
      )
      expect(image).not.toHaveBeenCalled()
      expect(create.mock.calls.some(([tag]) => String(tag) === 'canvas')).toBe(false)
    }
  )

  it.each([0, 11 * MiB])('非法%s字节压缩预算在读取前拒绝', async (budget) => {
    const read = vi.spyOn(FileReader.prototype, 'readAsArrayBuffer')
    await expect(compressPhoto(imageFile(signatures.png), budget)).rejects.toMatchObject({
      reason: 'compression-failed'
    })
    expect(read).not.toHaveBeenCalled()
  })

  it('超预算图片无法获得canvas上下文时拒绝，不偷偷返回超限原图', async () => {
    vi.stubGlobal(
      'Image',
      class {
        naturalWidth = 100
        naturalHeight = 100
        onload: (() => void) | null = null
        set src(_value: string) {
          queueMicrotask(() => this.onload?.())
        }
      }
    )
    const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    await expect(
      compressPhoto(imageFile(signatures.png, 'large.png', 'image/png', MiB + 1), MiB)
    ).rejects.toMatchObject({ reason: 'compression-failed' })
    expect(context).toHaveBeenCalledExactlyOnceWith('2d')
  })

  it('压缩最多尝试六次，全部超限则拒绝并清空canvas', async () => {
    vi.stubGlobal(
      'Image',
      class {
        naturalWidth = 100
        naturalHeight = 100
        onload: (() => void) | null = null
        set src(_value: string) {
          queueMicrotask(() => this.onload?.())
        }
      }
    )
    const context = {
      fillStyle: '',
      fillRect: vi.fn<CanvasRenderingContext2D['fillRect']>(),
      drawImage: vi.fn<(image: CanvasImageSource, ...coordinates: number[]) => void>()
    } satisfies Pick<CanvasRenderingContext2D, 'fillStyle' | 'fillRect' | 'drawImage'>
    let canvas: HTMLCanvasElement | undefined
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(function (this: HTMLCanvasElement) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        canvas = this
        return context as unknown as CanvasRenderingContext2D
      })
    const encode = vi
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue(`data:image/jpeg;base64,${'A'.repeat(Math.ceil((MiB + 1) / 3) * 4)}`)
    await expect(
      compressPhoto(imageFile(signatures.png, 'large.png', 'image/png', MiB + 1), MiB)
    ).rejects.toMatchObject({ reason: 'compression-failed' })
    expect(encode).toHaveBeenCalledTimes(6)
    expect(getContext).toHaveBeenCalledTimes(6)
    expect(context.drawImage).toHaveBeenCalledTimes(6)
    expect(context.fillStyle).toBe('#ffffff')
    expect(canvas?.width).toBe(0)
    expect(canvas?.height).toBe(0)
  })

  it('人物图恰好20MiB完整读取且不压缩', async () => {
    const image = vi.fn<() => void>()
    vi.stubGlobal('Image', image)
    const file = imageFile(signatures.webp, 'portrait.webp', 'image/webp', 20 * MiB)
    const result = await readAsDataUrl(file)
    expect(result.startsWith('data:image/webp;base64,')).toBe(true)
    expect(dataUrlBytes(result)).toBe(20 * MiB)
    expect(image).not.toHaveBeenCalled()
  })

  it.each([
    ['data:image/png;base64,YQ==', 1],
    ['data:image/png;base64,YWI=', 2],
    ['data:image/png;base64,YWJj', 3],
    ['没有逗号', Infinity],
    ['data:image/png;base64,', Infinity],
    ['data:image/png;base64,YQ', Infinity]
  ] as const)('dataUrlBytes准确计算%s', (url, bytes) => {
    expect(dataUrlBytes(url)).toBe(bytes)
  })

  it('typed WebCrypto替身按原始字节SHA-256去重，忽略MIME头并清零临时字节', async () => {
    const snapshots: number[][] = []
    const buffers: Uint8Array[] = []
    const digest = vi.fn<SubtleCrypto['digest']>().mockImplementation(async (_algorithm, input) => {
      const bytes =
        input instanceof ArrayBuffer
          ? new Uint8Array(input)
          : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      snapshots.push(Array.from(bytes))
      buffers.push(bytes)
      return new Uint8Array(Array.from({ length: 32 }, (_, index) => index)).buffer
    })
    const crypto = { subtle: { digest } satisfies Pick<SubtleCrypto, 'digest'> }
    vi.stubGlobal('crypto', crypto)
    const first = await hashImageDataUrl('data:image/png;base64,YWJj')
    const second = await hashImageDataUrl('data:image/jpeg;base64,YWJj')
    expect(first).toBe(
      Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, '0')).join('')
    )
    expect(second).toBe(first)
    expect(snapshots).toEqual([
      [97, 98, 99],
      [97, 98, 99]
    ])
    expect(digest.mock.calls.map(([algorithm]) => algorithm)).toEqual(['SHA-256', 'SHA-256'])
    expect(buffers.map((bytes) => Array.from(bytes))).toEqual([
      [0, 0, 0],
      [0, 0, 0]
    ])
  })

  it('没有WebCrypto时不伪造hash', async () => {
    vi.stubGlobal('crypto', {})
    await expect(hashImageDataUrl('data:image/png;base64,YQ==')).resolves.toBeUndefined()
  })

  it('hash失败仍清零临时字节，不伪造成功结果', async () => {
    let captured: Uint8Array | undefined
    const digest = vi.fn<SubtleCrypto['digest']>().mockImplementation(async (_algorithm, input) => {
      captured =
        input instanceof ArrayBuffer
          ? new Uint8Array(input)
          : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      throw new Error('摘要计算失败')
    })
    vi.stubGlobal('crypto', { subtle: { digest } satisfies Pick<SubtleCrypto, 'digest'> })
    await expect(hashImageDataUrl('data:image/png;base64,YQ==')).rejects.toThrow('摘要计算失败')
    expect(captured && Array.from(captured)).toEqual([0])
  })
})

describe('照片墙小页预览读取', () => {
  it('两页使用10张小页及递进cursor，只回传缩略图和原图hash，不读取原图API', async () => {
    const api = previewApi()
    const first = Array.from({ length: 10 }, (_, index) => thumbnail(index + 1))
    const second = [thumbnail(11)]
    api.listPhotoWallPhotoPage
      .mockResolvedValueOnce(page(first, 11, 10))
      .mockResolvedValueOnce(page(second, 11, null))
    const { operation } = await previewSession()
    const response = await loadPhotoWallPreview(operation)
    expect(api.listPhotoWallPhotoPage.mock.calls).toEqual([
      [{ afterId: 0, pageSize: 10 }],
      [{ afterId: 10, pageSize: 10 }]
    ])
    expect(response).toEqual({ success: true, data: [...first, ...second] })
    expect(
      response?.data?.every(
        (photo) => photo.dataUrl === 'data:image/png;base64,YQ==' && photo.sourceHash?.length === 64
      )
    ).toBe(true)
    expect(api.listPhotoWallPhotos).not.toHaveBeenCalled()
  })

  it.each(['页面切换', '账号变化'] as const)('%s后第一小页迟到，不发第二页', async (change) => {
    const api = previewApi()
    const pending = deferred<PageResponse>()
    api.listPhotoWallPhotoPage.mockReturnValue(pending.promise)
    const session = await previewSession()
    const result = loadPhotoWallPreview(session.operation)
    if (change === '页面切换') await session.router.push('/other')
    else session.session.setUser({ ...user, id: 2 })
    pending.resolve(
      page(
        Array.from({ length: 10 }, (_, index) => thumbnail(index + 1)),
        11,
        10
      )
    )
    await expect(result).resolves.toBeUndefined()
    expect(api.listPhotoWallPhotoPage).toHaveBeenCalledTimes(1)
    expect(session.session.currentUser?.id).toBe(change === '账号变化' ? 2 : 1)
  })

  it.each([0, 1, 10.5, Number.NaN])('拒绝无效nextCursor=%s而不发第二页', async (cursor) => {
    const api = previewApi()
    api.listPhotoWallPhotoPage.mockResolvedValue(
      page(
        Array.from({ length: 10 }, (_, index) => thumbnail(index + 1)),
        11,
        cursor
      )
    )
    const { operation } = await previewSession()
    await expect(loadPhotoWallPreview(operation)).resolves.toMatchObject({
      success: false,
      code: 'PHOTOWALL_PREVIEW_FAILED'
    })
    expect(api.listPhotoWallPhotoPage).toHaveBeenCalledTimes(1)
  })

  it('第二页重复cursor拒绝，不发第三页', async () => {
    const api = previewApi()
    api.listPhotoWallPhotoPage
      .mockResolvedValueOnce(
        page(
          Array.from({ length: 10 }, (_, index) => thumbnail(index + 1)),
          12,
          10
        )
      )
      .mockResolvedValueOnce(page([thumbnail(11)], 12, 10))
    const { operation } = await previewSession()
    await expect(loadPhotoWallPreview(operation)).resolves.toMatchObject({
      success: false,
      code: 'PHOTOWALL_PREVIEW_FAILED'
    })
    expect(api.listPhotoWallPhotoPage).toHaveBeenCalledTimes(2)
  })

  it('超过128KiB预算的小页缩略图拒绝而不回传', async () => {
    const api = previewApi()
    const tooLarge = {
      ...thumbnail(1),
      dataUrl: `data:image/png;base64,${'A'.repeat(Math.ceil((128 * 1024) / 3) * 4 + 65)}`
    }
    api.listPhotoWallPhotoPage.mockResolvedValue(page([tooLarge], 1, null))
    const { operation } = await previewSession()
    expect(await loadPhotoWallPreview(operation)).toEqual({
      success: false,
      code: 'PHOTOWALL_PREVIEW_FAILED',
      message: 'Photo wall changed or its preview could not be loaded. Please retry.'
    })
  })

  it('页间total变化拒绝，不能拼接不同快照', async () => {
    const api = previewApi()
    api.listPhotoWallPhotoPage
      .mockResolvedValueOnce(
        page(
          Array.from({ length: 10 }, (_, index) => thumbnail(index + 1)),
          11,
          10
        )
      )
      .mockResolvedValueOnce(page([thumbnail(11)], 12, null))
    const { operation } = await previewSession()
    await expect(loadPhotoWallPreview(operation)).resolves.toMatchObject({
      success: false,
      code: 'PHOTOWALL_PREVIEW_FAILED'
    })
  })

  it.each([
    ['重复id', [thumbnail(1), thumbnail(1)], 2],
    ['倒序id', [thumbnail(2), thumbnail(1)], 2],
    ['无效hash', [{ ...thumbnail(1), sourceHash: '不是原图hash' }], 1],
    ['total不匹配', [thumbnail(1)], 2]
  ] as const)('%s的小页响应拒绝', async (_name, items, total) => {
    const api = previewApi()
    api.listPhotoWallPhotoPage.mockResolvedValue(page([...items], total, null))
    const { operation } = await previewSession()
    await expect(loadPhotoWallPreview(operation)).resolves.toMatchObject({
      success: false,
      code: 'PHOTOWALL_PREVIEW_FAILED'
    })
  })
})
