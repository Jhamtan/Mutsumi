import sharp, { type OutputInfo } from 'sharp'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { AppError } from '../../../src/main/errors'
import {
  parseImageDataUrl,
  validateImageDataUrl
} from '../../../src/main/services/image-validation'

const formats = ['png', 'jpeg', 'gif', 'webp'] as const
const fixtures = {} as Record<(typeof formats)[number], Buffer>
const animations = {} as Record<'gif' | 'webp', Buffer>
const sixtyFrames = {} as Record<'gif' | 'webp', Buffer>
const tooManyFrames = {} as Record<'gif' | 'webp', Buffer>
let threeFrameGif: Buffer
const byteLimit = 100_000
const errorShape = {
  name: 'AppError',
  message: 'Invalid or oversized image.',
  code: 'INVALID_INPUT'
}

function asDataUrl(bytes: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${bytes.toString('base64')}`
}

async function makeImage(format: (typeof formats)[number], frames = 1): Promise<Buffer> {
  const pixels = Buffer.alloc(2 * 2 * frames * 4)
  try {
    for (let frame = 0; frame < frames; frame++) {
      for (let pixel = 0; pixel < 4; pixel++) {
        const offset = (frame * 4 + pixel) * 4
        pixels[offset] = (frame * 37 + pixel * 61) % 256
        pixels[offset + 1] = (frame * 67 + pixel * 41) % 256
        pixels[offset + 2] = (frame * 97 + pixel * 17) % 256
        pixels[offset + 3] = pixel === 0 ? 0 : 255
      }
    }
    const image = sharp(pixels, {
      raw: { width: 2, height: 2 * frames, channels: 4, pageHeight: 2 }
    })
    if (format === 'gif')
      return await image.gif({ delay: Array(frames).fill(20), loop: 0, dither: 0 }).toBuffer()
    if (format === 'webp')
      return await image.webp({ lossless: true, delay: Array(frames).fill(20), loop: 0 }).toBuffer()
    return await image.toFormat(format).toBuffer()
  } finally {
    pixels.fill(0)
  }
}

beforeAll(async () => {
  for (const format of formats) fixtures[format] = await makeImage(format)
  for (const format of ['gif', 'webp'] as const) {
    animations[format] = await makeImage(format, 2)
    sixtyFrames[format] = await makeImage(format, 60)
    tooManyFrames[format] = await makeImage(format, 61)
  }
  threeFrameGif = await makeImage('gif', 3)
})

function expectInvalid(action: () => unknown): void {
  expect(action).toThrow(AppError)
  try {
    action()
  } catch (error) {
    expect(error).toMatchObject(errorShape)
  }
}

// Decoder corruption tests deliberately allow invalid runtime channel counts.
type RawOutputOverrides = Partial<Omit<OutputInfo, 'channels'>> & { channels?: number }

function mockRaw(data: Buffer, changes: RawOutputOverrides = {}): void {
  vi.spyOn(sharp.prototype, 'toBuffer').mockResolvedValue({
    data,
    info: { format: 'raw', width: 2, height: 2, channels: 4, size: data.length, ...changes }
  } as never)
}

describe('parseImageDataUrl 严格同步边界', () => {
  it.each(formats)('解析真实 %s 并保留原始数据', (format) => {
    const original = fixtures[format]
    const dataUrl = asDataUrl(original, `image/${format}`)
    const parsed = parseImageDataUrl(dataUrl, original.length)
    expect(parsed.mimeType).toBe(`image/${format}`)
    expect(parsed.dataUrl).toBe(dataUrl)
    expect(parsed.bytes.equals(original)).toBe(true)
    expect(parsed.bytes).not.toBe(original)
  })

  it('先限制原始字符串长度，避免进行 base64 分配', () => {
    const from = vi.spyOn(Buffer, 'from')
    expectInvalid(() => parseImageDataUrl('A'.repeat(1000), 1))
    expect(from).not.toHaveBeenCalled()
  })

  it.each(['\r', '\n', '\r\n'])('拒绝换行 %j', (newline) => {
    const dataUrl = asDataUrl(fixtures.png, 'image/png')
    expectInvalid(() => parseImageDataUrl(dataUrl + newline, byteLimit))
    expectInvalid(() => parseImageDataUrl(dataUrl.replace(',', ',' + newline), byteLimit))
  })

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    '拒绝非法字节预算 %s',
    (maxBytes) => {
      expectInvalid(() => parseImageDataUrl(asDataUrl(fixtures.png, 'image/png'), maxBytes))
    }
  )

  it('按实际解码字节数检查精确边界', () => {
    const dataUrl = asDataUrl(fixtures.png, 'image/png')
    expect(parseImageDataUrl(dataUrl, fixtures.png.length).bytes.length).toBe(fixtures.png.length)
    expectInvalid(() => parseImageDataUrl(dataUrl, fixtures.png.length - 1))
  })

  it.each([
    '',
    'AAAA=AAA',
    'AAAA====',
    'AA==AAAA',
    'A===',
    'A',
    'AAAA AAAA',
    'AAAA\tAAAA',
    'AAAA-AAA',
    'AAAA_AAA',
    'AAAA%2B'
  ])('拒绝非严格 base64 %j', (encoded) => {
    expectInvalid(() => parseImageDataUrl(`data:image/png;base64,${encoded}`, byteLimit))
  })

  it('拒绝缺少 padding 和非零未使用 padding 位', () => {
    const fixture = Object.values(fixtures).find((bytes) => bytes.length % 3 !== 0)!
    const encoded = fixture.toString('base64')
    const format = formats.find((candidate) => fixtures[candidate] === fixture)!
    expectInvalid(() =>
      parseImageDataUrl(`data:image/${format};base64,${encoded.replace(/=+$/, '')}`, byteLimit)
    )
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const index = encoded.indexOf('=') - 1
    const alternative = alphabet[alphabet.indexOf(encoded[index]) | 1]
    const nonCanonical = encoded.slice(0, index) + alternative + encoded.slice(index + 1)
    expect(Buffer.from(nonCanonical, 'base64').equals(fixture)).toBe(true)
    const fill = vi.spyOn(Buffer.prototype, 'fill')
    expectInvalid(() => parseImageDataUrl(`data:image/${format};base64,${nonCanonical}`, byteLimit))
    expect(
      fill.mock.instances.some(
        (buffer) => buffer.length === fixture.length && buffer.every((value: number) => value === 0)
      )
    ).toBe(true)
  })

  it.each(['image/jpg', 'image/PNG', 'image/svg+xml', 'text/html', 'image/png;charset=utf-8'])(
    '拒绝标签 %s',
    (mime) => {
      expectInvalid(() => parseImageDataUrl(asDataUrl(fixtures.png, mime), byteLimit))
    }
  )

  it.each(formats)('拒绝 %s 内容伪装成另一 MIME', (format) => {
    const mime = format === 'png' ? 'image/jpeg' : 'image/png'
    expectInvalid(() => parseImageDataUrl(asDataUrl(fixtures[format], mime), byteLimit))
  })

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="2" height="2"/></svg>',
    '<html><img src=x></html>'
  ])('拒绝 SVG / HTML，即使标签为 PNG', (content) => {
    expectInvalid(() => parseImageDataUrl(asDataUrl(Buffer.from(content), 'image/png'), byteLimit))
  })

  it.each(formats)('拒绝真实 %s 截断', (format) => {
    const truncated = fixtures[format].subarray(0, fixtures[format].length - 3)
    expectInvalid(() => parseImageDataUrl(asDataUrl(truncated, `image/${format}`), byteLimit))
  })

  it.each([
    [0, 2],
    [2, 0],
    [16_385, 1],
    [1, 16_385],
    [4001, 4000]
  ])('在解码前拒绝 PNG 尺寸 %s x %s', (width, height) => {
    const image = Buffer.from(fixtures.png)
    image.writeUInt32BE(width, 16)
    image.writeUInt32BE(height, 20)
    const metadata = vi.spyOn(sharp.prototype, 'metadata')
    expectInvalid(() => parseImageDataUrl(asDataUrl(image, 'image/png'), byteLimit))
    expect(metadata).not.toHaveBeenCalled()
  })

  it('拒绝带高位伪造的 GIF / WebP 魔数', () => {
    for (const format of ['gif', 'webp'] as const) {
      const image = Buffer.from(fixtures[format])
      image[0] |= 0x80
      expectInvalid(() => parseImageDataUrl(asDataUrl(image, `image/${format}`), byteLimit))
    }
  })

  it('在调用解码器前检查 JPEG SOF 的像素预算', () => {
    const image = Buffer.from(fixtures.jpeg)
    const start = image.indexOf(Buffer.from([0xff, 0xc0]))
    expect(start).toBeGreaterThan(0)
    image.writeUInt16BE(4000, start + 5)
    image.writeUInt16BE(4001, start + 7)
    expectInvalid(() => parseImageDataUrl(asDataUrl(image, 'image/jpeg'), byteLimit))
  })

  it('在调用解码器前检查 WebP VP8L 的像素预算', () => {
    const image = Buffer.from(fixtures.webp)
    const start = image.indexOf('VP8L', 12, 'latin1') + 8
    expect(start).toBeGreaterThan(19)
    const bits = image.readUInt32LE(start + 1)
    image.writeUInt32LE(((bits & 0xf0000000) | (3999 << 14) | 4000) >>> 0, start + 1)
    expectInvalid(() => parseImageDataUrl(asDataUrl(image, 'image/webp'), byteLimit))
  })

  it('单帧恰好 16M 像素可通过同步预算检查', () => {
    const image = Buffer.from(fixtures.png)
    image.writeUInt32BE(4000, 16)
    image.writeUInt32BE(4000, 20)
    expect(parseImageDataUrl(asDataUrl(image, 'image/png'), byteLimit).bytes.equals(image)).toBe(
      true
    )
  })

  it.each(['gif', 'webp'] as const)('在真实 %s 头部发现超过 60 帧就拒绝', (format) => {
    expectInvalid(() =>
      parseImageDataUrl(asDataUrl(tooManyFrames[format], `image/${format}`), byteLimit)
    )
  })

  it('全部帧恰好 32M 像素可通过同步预算检查', () => {
    const image = Buffer.from(animations.gif)
    image.writeUInt16LE(4000, 6)
    image.writeUInt16LE(4000, 8)
    expect(parseImageDataUrl(asDataUrl(image, 'image/gif'), byteLimit).bytes.equals(image)).toBe(
      true
    )
  })

  it('检查 GIF 逻辑画布乘以全部帧，而非仅局部帧大小', () => {
    const image = Buffer.from(threeFrameGif)
    image.writeUInt16LE(4000, 6)
    image.writeUInt16LE(4000, 8)
    expectInvalid(() => parseImageDataUrl(asDataUrl(image, 'image/gif'), byteLimit))
  })

  it('无法完整解码的 APNG 不作为安全静态 PNG 放行', () => {
    const animationControl = Buffer.alloc(20)
    animationControl.writeUInt32BE(8, 0)
    animationControl.write('acTL', 4, 'ascii')
    animationControl.writeUInt32BE(2, 8)
    const image = Buffer.concat([
      fixtures.png.subarray(0, 33),
      animationControl,
      fixtures.png.subarray(33)
    ])
    expectInvalid(() => parseImageDataUrl(asDataUrl(image, 'image/png'), byteLimit))
  })
})

describe('validateImageDataUrl 真实像素解码', () => {
  it.each(formats)('完整解码真实 %s，返回未重编码原图', async (format) => {
    const dataUrl = asDataUrl(fixtures[format], `image/${format}`)
    const result = await validateImageDataUrl(dataUrl, byteLimit)
    expect(result).toMatchObject({
      mimeType: `image/${format}`,
      dataUrl,
      width: 2,
      height: 2,
      frames: 1
    })
    expect(result.bytes.equals(fixtures[format])).toBe(true)
  })

  it.each(['gif', 'webp'] as const)('保留真实 %s 动画、透明度和原始帧', async (format) => {
    const dataUrl = asDataUrl(animations[format], `image/${format}`)
    const result = await validateImageDataUrl(dataUrl, byteLimit)
    expect(result).toMatchObject({ width: 2, height: 2, frames: 2, dataUrl })
    expect(result.bytes.equals(animations[format])).toBe(true)
    expect(await sharp(result.bytes, { animated: true }).metadata()).toMatchObject({
      pages: 2,
      hasAlpha: true,
      loop: 0
    })
  })

  it.each(['gif', 'webp'] as const)('接受恰好 60 帧真实 %s', async (format) => {
    const result = await validateImageDataUrl(
      asDataUrl(sixtyFrames[format], `image/${format}`),
      byteLimit
    )
    expect(result.frames).toBe(60)
    expect(result.bytes.equals(sixtyFrames[format])).toBe(true)
  })

  it('拒绝 metadata 可读但 PNG 压缩像素损坏的图像', async () => {
    const image = Buffer.from(fixtures.png)
    let offset = 8
    while (image.toString('ascii', offset + 4, offset + 8) !== 'IDAT')
      offset += image.readUInt32BE(offset) + 12
    image.fill(0, offset + 8, offset + 8 + image.readUInt32BE(offset))
    expect(await sharp(image).metadata()).toMatchObject({ format: 'png', width: 2, height: 2 })
    await expect(
      validateImageDataUrl(asDataUrl(image, 'image/png'), byteLimit)
    ).rejects.toMatchObject(errorShape)
  })

  it('使用合法原生超时参数和全部帧读取，不依赖外层超时竞争', async () => {
    const timeout = vi.spyOn(sharp.prototype, 'timeout')
    const raw = vi.spyOn(sharp.prototype, 'raw')
    await validateImageDataUrl(asDataUrl(fixtures.png, 'image/png'), byteLimit)
    expect(timeout).toHaveBeenCalledWith({ seconds: 5 })
    expect(raw).toHaveBeenCalledWith({ depth: 'uchar' })
  })

  it.each([
    { format: 'jpeg' },
    { width: 0 },
    { height: 0 },
    { width: 4001, height: 4000 },
    { pages: 61, pageHeight: 2, height: 122 },
    { width: 4000, height: 12000, pageHeight: 4000, pages: 3 },
    { width: 1 },
    { channels: 5 },
    { pages: 2, pageHeight: 2, height: 5 }
  ])('拒绝完整解码输出的格式、尺寸或帧信息异常 %j', async (changes) => {
    const raw = Buffer.alloc(16, 7)
    mockRaw(raw, changes)
    const fill = vi.spyOn(Buffer.prototype, 'fill')
    await expect(
      validateImageDataUrl(asDataUrl(fixtures.png, 'image/png'), byteLimit)
    ).rejects.toMatchObject(errorShape)
    expect(raw.every((value) => value === 0)).toBe(true)
    expect(
      fill.mock.instances.some(
        (buffer) =>
          buffer.length === fixtures.png.length && buffer.every((value: number) => value === 0)
      )
    ).toBe(true)
  })

  it('成功后清零临时 raw 缓冲区，但保留原始输入字节', async () => {
    const raw = Buffer.alloc(16, 7)
    mockRaw(raw)
    const result = await validateImageDataUrl(asDataUrl(fixtures.png, 'image/png'), byteLimit)
    expect(raw.every((value) => value === 0)).toBe(true)
    expect(result.bytes.equals(fixtures.png)).toBe(true)
  })

  it('解码输出与 metadata 不符时，raw 和原始 bytes 均清零', async () => {
    const raw = Buffer.alloc(16, 7)
    mockRaw(raw, { width: 3 })
    const fill = vi.spyOn(Buffer.prototype, 'fill')
    await expect(
      validateImageDataUrl(asDataUrl(fixtures.png, 'image/png'), byteLimit)
    ).rejects.toMatchObject(errorShape)
    expect(raw.every((value) => value === 0)).toBe(true)
    expect(
      fill.mock.instances.some(
        (buffer) =>
          buffer.length === fixtures.png.length && buffer.every((value: number) => value === 0)
      )
    ).toBe(true)
  })

  it('完整解码不依赖独立 metadata 调用或其额外缓冲区', async () => {
    const metadata = vi
      .spyOn(sharp.prototype, 'metadata')
      .mockRejectedValue(new Error('metadata must not run'))
    const result = await validateImageDataUrl(asDataUrl(fixtures.png, 'image/png'), byteLimit)
    try {
      expect(metadata).not.toHaveBeenCalled()
      expect(result.bytes.equals(fixtures.png)).toBe(true)
    } finally {
      result.bytes.fill(0)
    }
  })

  it('完整解码失败或原生超时时清零 bytes，且不泄漏错误信息', async () => {
    vi.spyOn(sharp.prototype, 'toBuffer').mockRejectedValue(
      new Error('private image data / timeout')
    )
    const fill = vi.spyOn(Buffer.prototype, 'fill')
    await expect(
      validateImageDataUrl(asDataUrl(fixtures.png, 'image/png'), byteLimit)
    ).rejects.toMatchObject(errorShape)
    expect(
      fill.mock.instances.some(
        (buffer) =>
          buffer.length === fixtures.png.length && buffer.every((value: number) => value === 0)
      )
    ).toBe(true)
  })

  it('原生任务真正结束前保持最多 2 并发、8 个等待者，并拒绝溢出', async () => {
    const pending: Array<(result: unknown) => void> = []
    const started: Array<() => void> = []
    const toBuffer = vi.spyOn(sharp.prototype, 'toBuffer').mockImplementation(() => {
      const notify = started.shift()
      const operation = new Promise((resolve) => pending.push(resolve))
      notify?.()
      return operation as never
    })
    const waitForStart = (): Promise<void> => new Promise((resolve) => started.push(resolve))
    const dataUrl = asDataUrl(fixtures.png, 'image/png')
    const firstStarted = waitForStart()
    const secondStarted = waitForStart()
    const requests = Array.from({ length: 10 }, () => validateImageDataUrl(dataUrl, byteLimit))
    await Promise.all([firstStarted, secondStarted])
    try {
      expect(toBuffer).toHaveBeenCalledTimes(2)
      const fill = vi.spyOn(Buffer.prototype, 'fill')
      await expect(validateImageDataUrl(dataUrl, byteLimit)).rejects.toMatchObject(errorShape)
      expect(
        fill.mock.instances.some(
          (buffer) =>
            buffer.length === fixtures.png.length && buffer.every((value: number) => value === 0)
        )
      ).toBe(true)
      for (let index = 0; index < 10; index++) {
        const nextStarted = index < 8 ? waitForStart() : undefined
        const resolve = pending.shift()!
        resolve({
          data: Buffer.alloc(16, 7),
          info: { format: 'raw', width: 2, height: 2, channels: 4 }
        })
        if (nextStarted) await nextStarted
        expect(pending.length).toBeLessThanOrEqual(2)
      }
      expect(await Promise.all(requests)).toHaveLength(10)
      expect(toBuffer).toHaveBeenCalledTimes(10)
    } finally {
      // 测试失败也必须让模拟原生任务真正退出，避免占住模块级名额。
      toBuffer.mockResolvedValue({
        data: Buffer.alloc(16),
        info: { width: 2, height: 2, channels: 4 }
      } as never)
      for (const resolve of pending)
        resolve({ data: Buffer.alloc(16), info: { width: 2, height: 2, channels: 4 } })
      await Promise.allSettled(requests)
    }
  })

  it('失败释放名额后仍可继续真实解码', async () => {
    const decoder = vi
      .spyOn(sharp.prototype, 'toBuffer')
      .mockRejectedValue(new Error('native timeout'))
    await expect(
      validateImageDataUrl(asDataUrl(fixtures.png, 'image/png'), byteLimit)
    ).rejects.toMatchObject(errorShape)
    decoder.mockRestore()
    const result = await validateImageDataUrl(asDataUrl(fixtures.png, 'image/png'), byteLimit)
    expect(result.frames).toBe(1)
  })
})

describe('有限缩略图与原图分离', () => {
  it.each(formats)('微小%s的显示副本不改动原始文件', async (format) => {
    const source = asDataUrl(fixtures[format], `image/${format}`)
    const result = await validateImageDataUrl(source, byteLimit, undefined, {
      maxEdge: 640,
      maxBytes: 128 * 1024
    })
    expect(result.previewDataUrl).toBe(source)
    expect(result.bytes.equals(fixtures[format])).toBe(true)
    result.bytes.fill(0)
  })

  it('高分辨率透明PNG的显示副本被缩小而导出字节仍是原图', async () => {
    const source = await sharp({
      create: {
        width: 1280,
        height: 640,
        channels: 4,
        background: { r: 30, g: 120, b: 80, alpha: 0.4 }
      }
    })
      .png()
      .toBuffer()
    const result = await validateImageDataUrl(
      asDataUrl(source, 'image/png'),
      source.length,
      undefined,
      { maxEdge: 640, maxBytes: 128 * 1024 }
    )
    try {
      const preview = parseImageDataUrl(result.previewDataUrl!, 128 * 1024)
      try {
        expect(await sharp(preview.bytes).metadata()).toMatchObject({
          width: 640,
          height: 320,
          hasAlpha: true
        })
        expect(result.bytes.equals(source)).toBe(true)
        expect(result.width).toBe(1280)
      } finally {
        preview.bytes.fill(0)
      }
    } finally {
      result.bytes.fill(0)
      source.fill(0)
    }
  })

  it.each(['gif', 'webp'] as const)(
    '%s动画完整验证后，显示副本仅首帧而原图保留动画',
    async (format) => {
      const result = await validateImageDataUrl(
        asDataUrl(animations[format], `image/${format}`),
        byteLimit,
        undefined,
        { maxEdge: 640, maxBytes: 128 * 1024 }
      )
      const preview = parseImageDataUrl(result.previewDataUrl!, 128 * 1024)
      try {
        expect((await sharp(preview.bytes, { animated: true }).metadata()).pages ?? 1).toBe(1)
        expect(result.frames).toBe(2)
        expect(result.bytes.equals(animations[format])).toBe(true)
      } finally {
        result.bytes.fill(0)
        preview.bytes.fill(0)
      }
    }
  )

  it.each([
    { maxEdge: 0, maxBytes: 1024 },
    { maxEdge: 2049, maxBytes: 1024 },
    { maxEdge: 1.5, maxBytes: 1024 },
    { maxEdge: 640, maxBytes: 0 },
    { maxEdge: 640, maxBytes: Number.POSITIVE_INFINITY }
  ])('拒绝非法缩略图预算%j', async (options) => {
    await expect(
      validateImageDataUrl(asDataUrl(fixtures.png, 'image/png'), byteLimit, undefined, options)
    ).rejects.toMatchObject(errorShape)
  })

  it('缩略图转换失败同样清理原图和raw，并释放解码槽', async () => {
    const raw = Buffer.alloc(16, 7)
    const native = vi
      .spyOn(sharp.prototype, 'toBuffer')
      .mockResolvedValueOnce({
        data: raw,
        info: { format: 'raw', width: 2, height: 2, channels: 4 }
      } as never)
      .mockRejectedValueOnce(new Error('private conversion failure'))
    const fill = vi.spyOn(Buffer.prototype, 'fill')
    await expect(
      validateImageDataUrl(asDataUrl(fixtures.png, 'image/png'), byteLimit, undefined, {
        maxEdge: 1,
        maxBytes: 1024
      })
    ).rejects.toMatchObject(errorShape)
    expect(raw.every((value) => value === 0)).toBe(true)
    expect(
      fill.mock.instances.some(
        (buffer) =>
          buffer.length === fixtures.png.length && buffer.every((value: number) => value === 0)
      )
    ).toBe(true)
    native.mockRestore()
    const recovered = await validateImageDataUrl(asDataUrl(fixtures.png, 'image/png'), byteLimit)
    recovered.bytes.fill(0)
  })
})
