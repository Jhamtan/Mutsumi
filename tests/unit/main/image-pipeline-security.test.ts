import { afterEach, describe, expect, it, vi } from 'vitest'
import sharp, { type OutputInfo } from 'sharp'
import { AppError } from '../../../src/main/errors'
import {
  createImageValidationBudget,
  parseImageDataUrl,
  validateImageDataUrl,
  type ImageValidationBudget
} from '../../../src/main/services/image-validation'

const MAX_BYTES = 1024 * 1024
function dataUrl(bytes: Buffer, format = 'png'): string {
  return `data:image/${format};base64,${bytes.toString('base64')}`
}
async function smallImage(format: 'png' | 'jpeg' | 'gif' | 'webp' = 'png') {
  return sharp({
    create: { width: 2, height: 2, channels: 4, background: { r: 120, g: 50, b: 40, alpha: 0.5 } }
  })
    .toFormat(format)
    .toBuffer()
}
async function animatedImage(format: 'gif' | 'webp') {
  const pixels = Buffer.from([255, 0, 0, 255, 0, 0, 255, 255])
  try {
    return await sharp(pixels, { raw: { width: 1, height: 2, channels: 4, pageHeight: 1 } })
      .toFormat(format, { delay: [100, 100] })
      .toBuffer()
  } finally {
    pixels.fill(0)
  }
}

function damageLastFrame(image: Buffer, format: 'gif' | 'webp'): void {
  let payloads: Array<[number, number]> = []
  if (format === 'gif') {
    let offset = 13 + (image[10] & 0x80 ? 3 * (1 << ((image[10] & 7) + 1)) : 0)
    while (offset < image.length) {
      const marker = image[offset++]
      if (marker === 0x3b) break
      const frame = marker === 0x2c
      if (frame) {
        const packed = image[offset + 8]
        offset += 9 + (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0)
        offset++
        payloads = []
      } else if (marker === 0x21) {
        offset++
      } else {
        throw new Error('无效的内存 GIF fixture')
      }
      while (offset < image.length) {
        const size = image[offset++]
        if (!size) break
        if (frame) payloads.push([offset, offset + size])
        offset += size
      }
    }
  } else {
    let offset = 12
    while (offset + 8 <= image.length) {
      const size = image.readUInt32LE(offset + 4)
      if (image.toString('latin1', offset, offset + 4) === 'ANMF') {
        payloads = []
        let inner = offset + 8 + 16
        while (inner + 8 <= offset + 8 + size) {
          const chunk = image.toString('latin1', inner, inner + 4)
          const length = image.readUInt32LE(inner + 4)
          if (chunk === 'VP8 ' || chunk === 'VP8L') {
            payloads.push([inner + 8 + (chunk === 'VP8 ' ? 10 : 5), inner + 8 + length])
          }
          inner += 8 + length + (length & 1)
        }
      }
      offset += 8 + size + (size & 1)
    }
  }
  expect(payloads.length).toBeGreaterThan(0)
  for (const [start, end] of payloads) image.fill(0xff, start, end)
}

function decodedImage() {
  const data = Buffer.alloc(16, 127)
  const info: OutputInfo = {
    format: 'raw',
    width: 2,
    height: 2,
    channels: 4,
    size: data.length,
    premultiplied: false,
    hasAlpha: true
  }
  return { data, info }
}

function holdNativeDecoders(encoded: string, budget?: ImageValidationBudget) {
  const gates = Array.from({ length: 2 }, () => {
    let resolve!: (result: ReturnType<typeof decodedImage>) => void
    const promise = new Promise<ReturnType<typeof decodedImage>>((done) => {
      resolve = done
    })
    return { promise, resolve, result: decodedImage() }
  })
  const decode = vi
    .spyOn(sharp.prototype, 'toBuffer')
    .mockImplementation(() => Promise.resolve(decodedImage()))
    .mockReturnValueOnce(gates[0].promise)
    .mockReturnValueOnce(gates[1].promise)
  const running = Promise.allSettled([
    validateImageDataUrl(encoded, MAX_BYTES, budget),
    validateImageDataUrl(encoded, MAX_BYTES, budget)
  ])
  return {
    decode,
    running,
    gates,
    async finish() {
      for (const gate of gates) gate.resolve(gate.result)
      const results = await running
      for (const result of results) if (result.status === 'fulfilled') result.value.bytes.fill(0)
      return results
    }
  }
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

describe('independent image pipeline security', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it.each(['png', 'jpeg', 'gif', 'webp'] as const)(
    'decodes a complete %s and preserves its original bytes',
    async (format) => {
      const original = await smallImage(format)
      const validated = await validateImageDataUrl(dataUrl(original, format), MAX_BYTES)
      expect(validated).toMatchObject({
        width: 2,
        height: 2,
        frames: 1,
        mimeType: `image/${format}`
      })
      expect(validated.bytes.equals(original)).toBe(true)
      validated.bytes.fill(0)
      original.fill(0)
    }
  )

  it('rejects text disguised as a PNG and MIME mismatches', async () => {
    await expect(
      validateImageDataUrl(dataUrl(Buffer.from('not an image')), MAX_BYTES)
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    const png = await smallImage()
    await expect(validateImageDataUrl(dataUrl(png, 'jpeg'), MAX_BYTES)).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    })
    png.fill(0)
  })

  it('checks raw length, newlines, canonical padding and byte limits before decoding', async () => {
    const png = await smallImage()
    const encoded = dataUrl(png)
    for (const input of [
      encoded + '\n',
      encoded + '\r\n',
      'data:image/png;base64,A===',
      'x'.repeat(100)
    ]) {
      expect(() => parseImageDataUrl(input, 8)).toThrow()
    }
    expect(() => parseImageDataUrl(encoded, png.length - 1)).toThrow()
    png.fill(0)
  })

  it('does not accept an image with readable metadata but damaged compressed pixels', async () => {
    const png = await smallImage()
    let offset = 8
    while (offset + 12 <= png.length) {
      const size = png.readUInt32BE(offset)
      if (png.toString('latin1', offset + 4, offset + 8) === 'IDAT') {
        // Keep the PNG chunk CRC correct, but corrupt the deflate checksum.
        png[offset + 8 + size - 1] ^= 1
        png.writeUInt32BE(crc32(png.subarray(offset + 4, offset + 8 + size)), offset + 8 + size)
        break
      }
      offset += size + 12
    }
    expect((await sharp(png).metadata()).width).toBe(2)
    const parsed = parseImageDataUrl(dataUrl(png), MAX_BYTES)
    parsed.bytes.fill(0)
    await expect(validateImageDataUrl(dataUrl(png), MAX_BYTES)).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    })
    png.fill(0)
  })

  it('rejects oversized dimensions before entering the native decoder', async () => {
    const png = await smallImage()
    png.writeUInt32BE(5_000, 16)
    png.writeUInt32BE(4_000, 20)
    expect(() => parseImageDataUrl(dataUrl(png), MAX_BYTES)).toThrow()
    png.fill(0)
  })

  it.each(['gif', 'webp'] as const)(
    'decodes and validates every frame in animated %s',
    async (format) => {
      const image = await animatedImage(format)
      const validated = await validateImageDataUrl(dataUrl(image, format), MAX_BYTES)
      expect(validated).toMatchObject({ width: 1, height: 1, frames: 2 })
      expect(validated.bytes.equals(image)).toBe(true)
      validated.bytes.fill(0)
      image.fill(0)
    }
  )

  it.each(['gif', 'webp'] as const)(
    'rejects damaged compressed pixels in the last %s frame',
    async (format) => {
      const image = await animatedImage(format)
      damageLastFrame(image, format)
      const parsed = parseImageDataUrl(dataUrl(image, format), MAX_BYTES)
      parsed.bytes.fill(0)
      await expect(validateImageDataUrl(dataUrl(image, format), MAX_BYTES)).rejects.toMatchObject({
        code: 'INVALID_INPUT'
      })
      image.fill(0)
    }
  )

  it('does not export metadata buffers or re-encode transparent pixels', async () => {
    const image = await smallImage()
    const metadata = vi
      .spyOn(sharp.prototype, 'metadata')
      .mockRejectedValue(new Error('不得导出 metadata'))
    const validated = await validateImageDataUrl(dataUrl(image), MAX_BYTES)
    expect(metadata).not.toHaveBeenCalled()
    expect(validated.bytes.equals(image)).toBe(true)
    const pixels = await sharp(validated.bytes).raw().toBuffer()
    expect(pixels[3]).toBeGreaterThan(0)
    expect(pixels[3]).toBeLessThan(255)
    pixels.fill(0)
    validated.bytes.fill(0)
    image.fill(0)
  })

  it.each(['gif', 'webp'] as const)(
    'charges every %s frame against a shared pixel budget',
    async (format) => {
      const image = await animatedImage(format)
      const budget = createImageValidationBudget({ maxPixels: 3 })
      const first = await validateImageDataUrl(dataUrl(image, format), MAX_BYTES, budget)
      first.bytes.fill(0)
      const decode = vi.spyOn(sharp.prototype, 'toBuffer')
      await expect(
        validateImageDataUrl(dataUrl(image, format), MAX_BYTES, budget)
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      expect(decode).not.toHaveBeenCalled()
      image.fill(0)
    }
  )

  it('reserves cumulative pixels before awaiting concurrent validations', async () => {
    const image = await smallImage()
    const budget = createImageValidationBudget({ maxPixels: 4 })
    const results = await Promise.allSettled([
      validateImageDataUrl(dataUrl(image), MAX_BYTES, budget),
      validateImageDataUrl(dataUrl(image), MAX_BYTES, budget)
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    for (const result of results) if (result.status === 'fulfilled') result.value.bytes.fill(0)
    image.fill(0)
  })

  it('uses a default 256M pixel allowance and a monotonic 30-second deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const budget = createImageValidationBudget()
    budget.consumePixels(256_000_000)
    expect(() => budget.consumePixels(1)).toThrow()
    expect(budget.remainingMs()).toBe(30_000)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(() => budget.assertActive()).toThrow()
  })

  it.each([
    { maxPixels: 0 },
    { maxPixels: -1 },
    { maxPixels: 1.5 },
    { maxPixels: Infinity },
    { timeoutMs: 0 },
    { timeoutMs: -1 },
    { timeoutMs: 1.5 },
    { timeoutMs: Infinity },
    { timeoutMs: 2_147_483_648 }
  ])('rejects invalid budget options %j', (options) => {
    expect(() => createImageValidationBudget(options)).toThrow()
  })

  it('checks cancellation and deadline before allocating or decoding input', async () => {
    const image = await smallImage()
    const decode = vi.spyOn(sharp.prototype, 'toBuffer')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const expired = createImageValidationBudget({ timeoutMs: 10 })
    await vi.advanceTimersByTimeAsync(10)
    await expect(validateImageDataUrl(dataUrl(image), MAX_BYTES, expired)).rejects.toThrow()
    const cancelled = createImageValidationBudget({
      assertActive: () => {
        throw new Error('已取消')
      }
    })
    await expect(validateImageDataUrl(dataUrl(image), MAX_BYTES, cancelled)).rejects.toThrow()
    expect(decode).not.toHaveBeenCalled()
    image.fill(0)
  })

  it.each(['OPERATION_CANCELLED', 'AUTH_REQUIRED'] as const)(
    'preserves trusted %s errors before allocating or decoding input',
    async (code) => {
      const image = await smallImage()
      const error = new AppError('The operation is no longer authorized.', code)
      const budget = createImageValidationBudget({
        assertActive: () => {
          throw error
        }
      })
      const decode = vi.spyOn(sharp.prototype, 'toBuffer')
      try {
        await expect(validateImageDataUrl(dataUrl(image), MAX_BYTES, budget)).rejects.toBe(error)
        expect(decode).not.toHaveBeenCalled()
      } finally {
        image.fill(0)
      }
    }
  )

  it.each(['guard', 'native'] as const)(
    'normalizes unknown %s errors even if they imitate cancellation codes',
    async (source) => {
      const image = await smallImage()
      const error = Object.assign(new Error('private native details /tmp/secret.png'), {
        code: 'OPERATION_CANCELLED'
      })
      const budget = createImageValidationBudget({
        assertActive:
          source === 'guard'
            ? () => {
                throw error
              }
            : undefined
      })
      const decode = vi.spyOn(sharp.prototype, 'toBuffer').mockRejectedValue(error)
      const fill = vi.spyOn(Buffer.prototype, 'fill')
      try {
        await expect(validateImageDataUrl(dataUrl(image), MAX_BYTES, budget)).rejects.toMatchObject(
          {
            code: 'INVALID_INPUT',
            message: 'Invalid or oversized image.'
          }
        )
        if (source === 'guard') {
          expect(decode).not.toHaveBeenCalled()
        } else {
          expect(decode).toHaveBeenCalledTimes(1)
          expect(
            fill.mock.contexts.some(
              (value) =>
                Buffer.isBuffer(value) &&
                value.length === image.length &&
                value.every((byte) => byte === 0)
            )
          ).toBe(true)
        }
      } finally {
        image.fill(0)
      }
    }
  )

  it('rechecks cancellation after acquiring a slot and releases it without decoding', async () => {
    const image = await smallImage()
    const encoded = dataUrl(image)
    let active = true
    const cancelled = new AppError('The operation was cancelled.', 'OPERATION_CANCELLED')
    const budget = createImageValidationBudget({
      assertActive: () => {
        if (!active) throw cancelled
      }
    })
    const decode = vi.spyOn(sharp.prototype, 'toBuffer')
    const fill = vi.spyOn(Buffer.prototype, 'fill')
    const validation = validateImageDataUrl(encoded, MAX_BYTES, budget)
    active = false
    await expect(validation).rejects.toBe(cancelled)
    expect(decode).not.toHaveBeenCalled()
    expect(
      fill.mock.contexts.some(
        (value) =>
          Buffer.isBuffer(value) &&
          value.length === image.length &&
          value.every((byte) => byte === 0)
      )
    ).toBe(true)
    const next = await validateImageDataUrl(encoded, MAX_BYTES)
    next.bytes.fill(0)
    image.fill(0)
  })

  it.each(['budget', 'waiter'] as const)(
    'removes an expired %s waiter, clears input and keeps native slots occupied',
    async (kind) => {
      const image = await smallImage()
      const encoded = dataUrl(image)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
      const held = holdNativeDecoders(encoded)
      await Promise.resolve()
      const fill = vi.spyOn(Buffer.prototype, 'fill')
      const budget = createImageValidationBudget({ timeoutMs: kind === 'budget' ? 20 : 60_000 })
      const expired = Promise.allSettled([validateImageDataUrl(encoded, MAX_BYTES, budget)])
      const queued: Array<Promise<Awaited<ReturnType<typeof validateImageDataUrl>>>> = []
      try {
        for (let index = 0; index < 7; index++)
          queued.push(validateImageDataUrl(encoded, MAX_BYTES))
        const otherResults = Promise.allSettled(queued)
        await vi.advanceTimersByTimeAsync(kind === 'budget' ? 20 : 5_000)
        expect((await expired)[0].status).toBe('rejected')
        const cleared = fill.mock.contexts.filter(
          (value) => Buffer.isBuffer(value) && value.length === image.length
        )
        expect(cleared.length).toBeGreaterThanOrEqual(1)
        expect(cleared.every((value) => (value as Buffer).every((byte) => byte === 0))).toBe(true)
        expect(held.decode).toHaveBeenCalledTimes(2)
        queued.push(validateImageDataUrl(encoded, MAX_BYTES))
        const replacement = Promise.allSettled([queued[queued.length - 1]])
        await held.finish()
        expect((await replacement)[0].status).toBe('fulfilled')
        for (const result of [...(await otherResults), ...(await replacement)]) {
          if (result.status === 'fulfilled') result.value.bytes.fill(0)
        }
      } finally {
        await held.finish()
        for (const result of await Promise.allSettled(queued)) {
          if (result.status === 'fulfilled') result.value.bytes.fill(0)
        }
        image.fill(0)
      }
    }
  )

  it.each(['poll', 'handoff'] as const)(
    'removes cancelled waiters during %s without starting a native decode',
    async (mode) => {
      const image = await smallImage()
      const encoded = dataUrl(image)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
      const held = holdNativeDecoders(encoded)
      await Promise.resolve()
      let active = true
      const cancelled = new AppError('The operation was cancelled.', 'OPERATION_CANCELLED')
      const budget = createImageValidationBudget({
        assertActive: () => {
          if (!active) throw cancelled
        }
      })
      const fill = vi.spyOn(Buffer.prototype, 'fill')
      const queued = Promise.allSettled([validateImageDataUrl(encoded, MAX_BYTES, budget)])
      try {
        active = false
        if (mode === 'poll') {
          await vi.advanceTimersByTimeAsync(50)
          const [cancelledResult] = await queued
          expect(cancelledResult.status).toBe('rejected')
          expect(cancelledResult.status === 'rejected' && cancelledResult.reason).toBe(cancelled)
          expect(held.decode).toHaveBeenCalledTimes(2)
          expect(
            fill.mock.contexts.some(
              (value) =>
                Buffer.isBuffer(value) &&
                value.length === image.length &&
                value.every((byte) => byte === 0)
            )
          ).toBe(true)
        }
        await held.finish()
        const [cancelledResult] = await queued
        expect(cancelledResult.status).toBe('rejected')
        expect(cancelledResult.status === 'rejected' && cancelledResult.reason).toBe(cancelled)
        expect(held.decode).toHaveBeenCalledTimes(2)
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        await held.finish()
        await queued
        image.fill(0)
      }
    }
  )

  it.each(['deadline', 'cancel'] as const)(
    'does not release running native reservations early on %s',
    async (mode) => {
      const image = await smallImage()
      const encoded = dataUrl(image)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
      let active = true
      const cancelled = new AppError('The operation was cancelled.', 'OPERATION_CANCELLED')
      const budget = createImageValidationBudget({
        timeoutMs: mode === 'deadline' ? 20 : 30_000,
        assertActive: () => {
          if (!active) throw cancelled
        }
      })
      const held = holdNativeDecoders(encoded, budget)
      await Promise.resolve()
      const fill = vi.spyOn(Buffer.prototype, 'fill')
      let settled = false
      void held.running.then(() => {
        settled = true
      })
      const queued: Array<Promise<Awaited<ReturnType<typeof validateImageDataUrl>>>> = []
      try {
        if (mode === 'cancel') active = false
        await vi.advanceTimersByTimeAsync(20)
        expect(settled).toBe(false)
        expect(fill).not.toHaveBeenCalled()
        expect(held.gates.every((gate) => gate.result.data.some((byte) => byte !== 0))).toBe(true)
        queued.push(validateImageDataUrl(encoded, MAX_BYTES))
        await Promise.resolve()
        expect(held.decode).toHaveBeenCalledTimes(2)
        const results = await held.finish()
        expect(results.every((result) => result.status === 'rejected')).toBe(true)
        if (mode === 'cancel') {
          expect(
            results.every((result) => result.status === 'rejected' && result.reason === cancelled)
          ).toBe(true)
        }
        expect(held.gates.every((gate) => gate.result.data.every((byte) => byte === 0))).toBe(true)
        const next = await queued[0]
        next.bytes.fill(0)
        expect(held.decode).toHaveBeenCalledTimes(3)
      } finally {
        await held.finish()
        for (const result of await Promise.allSettled(queued)) {
          if (result.status === 'fulfilled') result.value.bytes.fill(0)
        }
        image.fill(0)
      }
    }
  )

  it('rejects inconsistent raw page information and clears the decoded buffer', async () => {
    const image = await animatedImage('gif')
    const decoded = {
      data: Buffer.alloc(8, 127),
      info: { ...decodedImage().info, width: 1, height: 2, pages: 1, pageHeight: 1, size: 8 }
    }
    vi.spyOn(sharp.prototype, 'toBuffer').mockResolvedValue(decoded)
    await expect(validateImageDataUrl(dataUrl(image, 'gif'), MAX_BYTES)).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    })
    expect(decoded.data.every((byte) => byte === 0)).toBe(true)
    image.fill(0)
  })

  it('keeps the native decode queue bounded and releases reservations', async () => {
    const png = await smallImage()
    const encoded = dataUrl(png)
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => validateImageDataUrl(encoded, MAX_BYTES))
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(10)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(2)
    for (const result of results) if (result.status === 'fulfilled') result.value.bytes.fill(0)
    const next = await validateImageDataUrl(encoded, MAX_BYTES)
    next.bytes.fill(0)
    png.fill(0)
  })
})
