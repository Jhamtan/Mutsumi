import sharp from 'sharp'
import { AppError } from '../errors'

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

type ParsedImage = { mimeType: ImageMimeType; bytes: Buffer; dataUrl: string }
type ImageDimensions = { width: number; height: number; frames: number }

/** A fixed-size display copy; the original is still fully validated, and animated previews show only the first frame. */
export type ImageThumbnailOptions = {
  maxEdge: number
  maxBytes: number
}

export type ImageValidationBudgetOptions = {
  maxPixels?: number
  timeoutMs?: number
  assertActive?: () => void
}

export type ImageValidationBudget = {
  assertActive(): void
  remainingMs(): number
  consumePixels(pixels: number): void
}

const MAX_DIMENSION = 16_384
const MAX_FRAME_PIXELS = 16_000_000
const MAX_TOTAL_PIXELS = 32_000_000
const MAX_FRAMES = 60
const MAX_DECODERS = 2
const MAX_WAITERS = 8
const DECODE_SECONDS = 5
const MAX_WAIT_MS = 5_000
const WAITER_POLL_MS = 50
const DEFAULT_BUDGET_PIXELS = 256_000_000
const DEFAULT_BUDGET_MS = 30_000
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

let activeDecoders = 0
const waitingDecoders: Array<{ grant(): boolean }> = []

function invalidImage(): AppError {
  return new AppError('Invalid or oversized image.', 'INVALID_INPUT')
}

function imageValidationError(error: unknown): AppError {
  // Preserve the cancellation/auth error identity from trusted business checks; unknown parse and native-decode exceptions are still sanitized.
  return error instanceof AppError ? error : invalidImage()
}

export function createImageValidationBudget({
  maxPixels = DEFAULT_BUDGET_PIXELS,
  timeoutMs = DEFAULT_BUDGET_MS,
  assertActive: checkActive
}: ImageValidationBudgetOptions = {}): ImageValidationBudget {
  if (
    !Number.isSafeInteger(maxPixels) ||
    maxPixels < 1 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2_147_483_647
  ) {
    throw invalidImage()
  }
  const deadline = performance.now() + timeoutMs
  let remainingPixels = maxPixels
  function assertActive(): void {
    checkActive?.()
    if (performance.now() >= deadline) throw invalidImage()
  }
  return {
    assertActive,
    remainingMs() {
      assertActive()
      return Math.max(0, deadline - performance.now())
    },
    consumePixels(pixels) {
      assertActive()
      if (!Number.isSafeInteger(pixels) || pixels < 1 || pixels > remainingPixels)
        throw invalidImage()
      // Do not refund reserved work on failure or cancellation, so a batch cannot be re-submitted to exhaust decode resources.
      remainingPixels -= pixels
    }
  }
}

function checkDimensions(width: number, height: number, frames = 1): ImageDimensions {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    !Number.isSafeInteger(frames) ||
    width < 1 ||
    height < 1 ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    frames < 1 ||
    frames > MAX_FRAMES ||
    width * height > MAX_FRAME_PIXELS ||
    width * height * frames > MAX_TOTAL_PIXELS
  ) {
    throw invalidImage()
  }
  return { width, height, frames }
}

function pngDimensions(bytes: Buffer): ImageDimensions {
  if (
    bytes.length < 33 ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString('latin1', 12, 16) !== 'IHDR'
  ) {
    throw invalidImage()
  }
  const dimensions = checkDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
  let offset = 8
  let hasPixels = false
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset)
    const end = offset + 12 + size
    if (end > bytes.length) throw invalidImage()
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    // The current PNG decoder does not validate every APNG frame, so validating only the default static frame is not enough.
    if (type === 'acTL') throw invalidImage()
    if (type === 'IDAT' && size > 0) hasPixels = true
    if (type === 'IEND') {
      if (size !== 0 || end !== bytes.length || !hasPixels) throw invalidImage()
      return dimensions
    }
    offset = end
  }
  throw invalidImage()
}

function jpegDimensions(bytes: Buffer): ImageDimensions {
  if (bytes.length < 4 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) {
    throw invalidImage()
  }
  let offset = 2
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) throw invalidImage()
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === 0xda || marker === 0xd9 || marker === undefined) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) break
    const size = bytes.readUInt16BE(offset)
    if (size < 2 || offset + size > bytes.length) break
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (size < 8) break
      return checkDimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3))
    }
    offset += size
  }
  throw invalidImage()
}

function gifDimensions(bytes: Buffer): ImageDimensions {
  if (bytes.length < 13) throw invalidImage()
  const { width, height } = checkDimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8))
  let offset = 13 + (bytes[10] & 0x80 ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0)
  let frames = 0
  function skipBlocks(): void {
    while (offset < bytes.length) {
      const size = bytes[offset++]
      if (size === 0) return
      offset += size
      if (offset > bytes.length) break
    }
    throw invalidImage()
  }
  while (offset < bytes.length) {
    const block = bytes[offset++]
    if (block === 0x3b) {
      if (offset !== bytes.length) throw invalidImage()
      return checkDimensions(width, height, frames)
    }
    if (block === 0x21) {
      if (offset >= bytes.length) throw invalidImage()
      offset++
      skipBlocks()
    } else if (block === 0x2c) {
      if (offset + 9 > bytes.length) throw invalidImage()
      const left = bytes.readUInt16LE(offset)
      const top = bytes.readUInt16LE(offset + 2)
      const frameWidth = bytes.readUInt16LE(offset + 4)
      const frameHeight = bytes.readUInt16LE(offset + 6)
      checkDimensions(frameWidth, frameHeight)
      if (left + frameWidth > width || top + frameHeight > height) throw invalidImage()
      checkDimensions(width, height, ++frames)
      const packed = bytes[offset + 8]
      offset += 9 + (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0)
      if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) throw invalidImage()
      offset++
      skipBlocks()
    } else {
      throw invalidImage()
    }
  }
  throw invalidImage()
}

function webpDimensions(bytes: Buffer): ImageDimensions {
  if (bytes.length < 20 || bytes.readUInt32LE(4) !== bytes.length - 8) throw invalidImage()
  let offset = 12
  let dimensions: ImageDimensions | undefined
  let frames = 0
  let hasPixels = false
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('latin1', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const start = offset + 8
    const end = start + size + (size & 1)
    if (end > bytes.length) throw invalidImage()
    if (type === 'VP8X') {
      if (size !== 10 || dimensions) throw invalidImage()
      dimensions = checkDimensions(
        bytes.readUIntLE(start + 4, 3) + 1,
        bytes.readUIntLE(start + 7, 3) + 1
      )
    } else if (type === 'VP8 ' || type === 'VP8L') {
      let width: number
      let height: number
      if (type === 'VP8 ') {
        if (size < 10 || bytes.readUIntLE(start + 3, 3) !== 0x2a019d) throw invalidImage()
        width = bytes.readUInt16LE(start + 6) & 0x3fff
        height = bytes.readUInt16LE(start + 8) & 0x3fff
      } else {
        if (size < 5 || bytes[start] !== 0x2f) throw invalidImage()
        const bits = bytes.readUInt32LE(start + 1)
        width = (bits & 0x3fff) + 1
        height = ((bits >>> 14) & 0x3fff) + 1
      }
      checkDimensions(width, height)
      if (dimensions && (dimensions.width !== width || dimensions.height !== height)) {
        throw invalidImage()
      }
      dimensions = checkDimensions(width, height)
      hasPixels = true
    } else if (type === 'ANMF') {
      if (size < 16 || !dimensions) throw invalidImage()
      const left = bytes.readUIntLE(start, 3) * 2
      const top = bytes.readUIntLE(start + 3, 3) * 2
      const width = bytes.readUIntLE(start + 6, 3) + 1
      const height = bytes.readUIntLE(start + 9, 3) + 1
      checkDimensions(width, height)
      if (left + width > dimensions.width || top + height > dimensions.height) throw invalidImage()
      checkDimensions(dimensions.width, dimensions.height, ++frames)
      hasPixels = true
    }
    offset = end
  }
  if (offset !== bytes.length || !dimensions || !hasPixels) throw invalidImage()
  return checkDimensions(dimensions.width, dimensions.height, frames || 1)
}

function inspectHeader(bytes: Buffer, mimeType: ImageMimeType): ImageDimensions {
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE) && mimeType === 'image/png') {
    return pngDimensions(bytes)
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    mimeType === 'image/jpeg'
  ) {
    return jpegDimensions(bytes)
  }
  const signature = bytes.toString('latin1', 0, 6)
  if ((signature === 'GIF87a' || signature === 'GIF89a') && mimeType === 'image/gif') {
    return gifDimensions(bytes)
  }
  if (
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP' &&
    mimeType === 'image/webp'
  ) {
    return webpDimensions(bytes)
  }
  throw invalidImage()
}

export function parseImageDataUrl(dataUrl: string, maxBytes: number): ParsedImage {
  let bytes: Buffer | undefined
  try {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      typeof dataUrl !== 'string' ||
      dataUrl.length > Math.ceil(maxBytes / 3) * 4 + 64 ||
      /[\r\n]/.test(dataUrl)
    ) {
      throw invalidImage()
    }
    const comma = dataUrl.indexOf(',')
    const header = dataUrl.slice(0, comma)
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64$/.exec(header)
    if (!match) throw invalidImage()
    const encoded = dataUrl.slice(comma + 1)
    if (!encoded.length || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      throw invalidImage()
    }
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
    const decodedLength = (encoded.length / 4) * 3 - padding
    if (decodedLength < 1 || decodedLength > maxBytes) throw invalidImage()
    bytes = Buffer.from(encoded, 'base64')
    if (bytes.length !== decodedLength || bytes.toString('base64') !== encoded) throw invalidImage()
    const mimeType = match[1] as ImageMimeType
    inspectHeader(bytes, mimeType)
    return { mimeType, bytes, dataUrl }
  } catch {
    bytes?.fill(0)
    throw invalidImage()
  }
}

function releaseDecoder(): void {
  let next: { grant(): boolean } | undefined
  while ((next = waitingDecoders.shift())) {
    if (next.grant()) return
  }
  activeDecoders--
}

function acquireDecoder(budget: ImageValidationBudget): Promise<() => void> {
  budget.assertActive()
  if (activeDecoders < MAX_DECODERS) {
    activeDecoders++
    return Promise.resolve(releaseDecoder)
  }
  if (waitingDecoders.length >= MAX_WAITERS) throw invalidImage()
  const deadline = performance.now() + Math.min(MAX_WAIT_MS, budget.remainingMs())
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    function assertWaiting(): void {
      budget.assertActive()
      if (performance.now() >= deadline) throw invalidImage()
    }
    const waiter = {
      grant(): boolean {
        clearTimeout(timer)
        try {
          assertWaiting()
          resolve(releaseDecoder)
          return true
        } catch (error) {
          reject(imageValidationError(error))
          return false
        }
      }
    }
    function poll(): void {
      try {
        assertWaiting()
        timer = setTimeout(
          poll,
          Math.max(1, Math.min(WAITER_POLL_MS, deadline - performance.now()))
        )
      } catch (error) {
        const index = waitingDecoders.indexOf(waiter)
        if (index !== -1) waitingDecoders.splice(index, 1)
        reject(imageValidationError(error))
      }
    }
    waitingDecoders.push(waiter)
    poll()
  })
}

export async function validateImageDataUrl(
  dataUrl: string,
  maxBytes: number,
  budget: ImageValidationBudget = createImageValidationBudget(),
  thumbnail?: ImageThumbnailOptions
): Promise<ParsedImage & ImageDimensions & { previewDataUrl?: string }> {
  let parsed: ParsedImage | undefined
  let release: (() => void) | undefined
  let raw: Buffer | undefined
  let thumbnailBytes: Buffer | undefined
  let accepted = false
  try {
    budget.assertActive()
    if (
      thumbnail &&
      (!Number.isSafeInteger(thumbnail.maxEdge) ||
        thumbnail.maxEdge < 1 ||
        thumbnail.maxEdge > 2048 ||
        !Number.isSafeInteger(thumbnail.maxBytes) ||
        thumbnail.maxBytes < 1024 ||
        thumbnail.maxBytes > 1024 * 1024)
    )
      throw invalidImage()
    parsed = parseImageDataUrl(dataUrl, maxBytes)
    budget.assertActive()
    const dimensions = inspectHeader(parsed.bytes, parsed.mimeType)
    // Charge the pixel budget before the expensive native decode.
    budget.consumePixels(dimensions.width * dimensions.height * dimensions.frames)
    budget.assertActive()
    // Gate native decoding through a small semaphore that shares the overall budget.
    release = await acquireDecoder(budget)
    budget.assertActive()
    const decoder = sharp(parsed.bytes, {
      animated: true,
      failOn: 'warning',
      limitInputPixels: MAX_TOTAL_PIXELS,
      sequentialRead: true
    }).timeout({
      seconds: Math.max(1, Math.min(DECODE_SECONDS, Math.ceil(budget.remainingMs() / 1000)))
    })
    // The signature and container pre-checks pin the input format; a single native call fully decodes all frames without exporting metadata/gainMap buffers.
    budget.assertActive()
    const decoded = await decoder
      .toColourspace('srgb')
      .raw({ depth: 'uchar' })
      .toBuffer({ resolveWithObject: true })
    raw = decoded.data
    budget.assertActive()
    if (
      decoded.info.format !== 'raw' ||
      decoded.info.width !== dimensions.width ||
      decoded.info.height !== dimensions.height * dimensions.frames ||
      (decoded.info.pages ?? 1) !== dimensions.frames ||
      (decoded.info.pageHeight ?? decoded.info.height) !== dimensions.height ||
      decoded.info.channels < 1 ||
      decoded.info.channels > 4 ||
      raw.length !==
        dimensions.width * dimensions.height * dimensions.frames * decoded.info.channels ||
      raw.length > MAX_TOTAL_PIXELS * 4
    ) {
      throw invalidImage()
    }
    budget.assertActive()
    let previewDataUrl: string | undefined
    // Build a bounded preview copy from the already-decoded first frame when requested.
    if (thumbnail) {
      if (
        dimensions.frames === 1 &&
        parsed.bytes.length <= thumbnail.maxBytes &&
        Math.max(dimensions.width, dimensions.height) <= thumbnail.maxEdge
      ) {
        previewDataUrl = parsed.dataUrl
      } else {
        // The native decode slot is released only after thumbnail conversion; do not re-decode the original in another unbounded queue.
        const channels = decoded.info.channels as 1 | 2 | 3 | 4
        const firstFrame = raw.subarray(0, dimensions.width * dimensions.height * channels)
        for (let attempt = 0; attempt < 5; attempt++) {
          budget.assertActive()
          const edge = Math.max(1, Math.floor(thumbnail.maxEdge * 0.75 ** attempt))
          const converter = sharp(firstFrame, {
            raw: { width: dimensions.width, height: dimensions.height, channels },
            limitInputPixels: MAX_FRAME_PIXELS,
            sequentialRead: true
          }).timeout({
            seconds: Math.max(1, Math.min(DECODE_SECONDS, Math.ceil(budget.remainingMs() / 1000)))
          })
          thumbnailBytes = await converter
            .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: Math.max(45, 82 - attempt * 8), effort: 1 })
            .toBuffer()
          budget.assertActive()
          if (thumbnailBytes.length <= thumbnail.maxBytes) {
            const preview = inspectHeader(thumbnailBytes, 'image/webp')
            if (preview.frames !== 1 || preview.width > edge || preview.height > edge)
              throw invalidImage()
            previewDataUrl = `data:image/webp;base64,${thumbnailBytes.toString('base64')}`
            break
          }
          thumbnailBytes.fill(0)
          thumbnailBytes = undefined
        }
        if (!previewDataUrl) throw invalidImage()
      }
    }
    budget.assertActive()
    accepted = true
    return { ...parsed, ...dimensions, ...(previewDataUrl ? { previewDataUrl } : {}) }
  } catch (error) {
    throw imageValidationError(error)
  } finally {
    thumbnailBytes?.fill(0)
    raw?.fill(0)
    if (!accepted) parsed?.bytes.fill(0)
    // The native timeout does not cover libuv queueing/opening input and is not a hard total limit; release only after the native Promise ends, even past deadline or cancellation.
    release?.()
  }
}
