/** Photo wall image reading: detect format by file signature, keep originals within the per-image limit, and compress only when over it. */
import {
  PHOTOWALL_IMAGE_MAX_BYTES,
  PHOTOWALL_IMAGE_MIN_BYTES,
  PHOTOWALL_IMAGE_HARD_MAX_BYTES,
  PHOTOWALL_PORTRAIT_MAX_BYTES,
  PHOTOWALL_BATCH_MAX_BYTES
} from '@common/photowall'

type SupportedImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
export class PhotoWallImageError extends Error {
  constructor(
    readonly reason: 'unsupported' | 'file-too-large' | 'pixel-limit' | 'compression-failed'
  ) {
    super(reason)
  }
}

function readFile(file: Blob, mode: 'header' | 'dataUrl'): Promise<ArrayBuffer | string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string' || reader.result instanceof ArrayBuffer)
        resolve(reader.result)
      else reject(new Error('Unable to read image'))
    }
    reader.onerror = () => reject(new Error('Unable to read image'))
    reader.onabort = () => reject(new Error('Image read cancelled'))
    if (mode === 'header') reader.readAsArrayBuffer(file)
    else reader.readAsDataURL(file)
  })
}

/** Neither the file name nor File.type is a trustworthy format; the main process still fully decodes and validates. */
export function detectImageMime(bytes: Uint8Array): SupportedImageMime | undefined {
  const png = [137, 80, 78, 71, 13, 10, 26, 10]
  if (bytes.length >= png.length && png.every((value, index) => bytes[index] === value))
    return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg'
  const text = String.fromCharCode(...bytes.subarray(0, 12))
  if (text.startsWith('GIF87a') || text.startsWith('GIF89a')) return 'image/gif'
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return 'image/webp'
  return undefined
}

export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return Number.POSITIVE_INFINITY
  const encoded = dataUrl.length - comma - 1
  const padding = dataUrl.endsWith('==') ? 2 : dataUrl.endsWith('=') ? 1 : 0
  return encoded > 0 && encoded % 4 === 0 ? (encoded / 4) * 3 - padding : Number.POSITIVE_INFINITY
}

/** The portrait defaults to a 20 MiB cap; regular photos are also subject to a 25 MiB raw batch limit before reading. */
export async function readAsDataUrl(
  file: File,
  maxBytes = PHOTOWALL_PORTRAIT_MAX_BYTES
): Promise<string> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > PHOTOWALL_BATCH_MAX_BYTES ||
    file.size < 1 ||
    file.size > maxBytes
  )
    throw new PhotoWallImageError('file-too-large')
  const header = await readFile(file.slice(0, 12), 'header')
  if (!(header instanceof ArrayBuffer)) throw new PhotoWallImageError('unsupported')
  const mime = detectImageMime(new Uint8Array(header))
  if (!mime) throw new PhotoWallImageError('unsupported')
  const result = await readFile(file, 'dataUrl')
  if (typeof result !== 'string' || !result.includes(';base64,'))
    throw new PhotoWallImageError('unsupported')
  // Only correct the MIME header the browser derived from the extension; do not alter content or pretend an unknown format is supported.
  return `data:${mime};base64,${result.slice(result.indexOf(',') + 1)}`
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new PhotoWallImageError('unsupported'))
    image.src = url
  })
}

/** Keep original clarity within the limit; on overflow, scale/compress a bounded number of times, and reject instead of silently ignoring the limit when it cannot be met. */
export async function compressPhoto(
  file: File,
  maxBytes = PHOTOWALL_IMAGE_MAX_BYTES,
  maxEdge = 2560,
  quality = 0.9
): Promise<string> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < PHOTOWALL_IMAGE_MIN_BYTES ||
    maxBytes > PHOTOWALL_IMAGE_HARD_MAX_BYTES ||
    !Number.isSafeInteger(maxEdge) ||
    maxEdge < 1 ||
    maxEdge > 4096 ||
    !Number.isFinite(quality) ||
    quality <= 0 ||
    quality > 1
  ) {
    throw new PhotoWallImageError('compression-failed')
  }
  const dataUrl = await readAsDataUrl(file, PHOTOWALL_BATCH_MAX_BYTES)
  if (file.size <= maxBytes) return dataUrl
  const image = await loadImage(dataUrl)
  if (
    image.naturalWidth < 1 ||
    image.naturalHeight < 1 ||
    image.naturalWidth > 16384 ||
    image.naturalHeight > 16384 ||
    image.naturalWidth * image.naturalHeight > 16_000_000
  )
    throw new PhotoWallImageError('pixel-limit')
  const canvas = document.createElement('canvas')
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      const scale = Math.min(
        1,
        (maxEdge * 0.8 ** attempt) / Math.max(image.naturalWidth, image.naturalHeight)
      )
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
      const context = canvas.getContext('2d')
      if (!context) throw new PhotoWallImageError('compression-failed')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      const result = canvas.toDataURL('image/jpeg', Math.max(0.45, quality - attempt * 0.07))
      if (result.startsWith('data:image/jpeg;base64,') && dataUrlBytes(result) <= maxBytes)
        return result
    }
    throw new PhotoWallImageError('compression-failed')
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
}

/** A thumbnail is not the original; dedupe by SHA-256 of the raw bytes, falling back to exact data URL matching when WebCrypto is unavailable. */
export async function hashImageDataUrl(dataUrl: string): Promise<string | undefined> {
  if (!globalThis.crypto?.subtle) return undefined
  const bytes = globalThis.atob(dataUrl.slice(dataUrl.indexOf(',') + 1))
  const binary = new Uint8Array(bytes.length)
  for (let index = 0; index < bytes.length; index++) binary[index] = bytes.charCodeAt(index)
  try {
    const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', binary))
    return Array.from(hash, (value) => value.toString(16).padStart(2, '0')).join('')
  } finally {
    binary.fill(0)
  }
}
