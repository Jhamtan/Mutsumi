/**
 * Stores draft images as separate localStorage entries referenced by short
 * `draft-image://` ids, keeping base64 data out of the Markdown source.
 */
import type { DiaryImageInputDTO } from '@common/diary'

const DRAFT_IMAGE_SCHEME = 'draft-image://'
const IMAGE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/
const SAFE_IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp);base64,/i

function imageKeyPrefix(storageKey: string): string {
  return `${storageKey}:image:`
}

function imageKey(storageKey: string, imageId: string): string {
  return `${imageKeyPrefix(storageKey)}${imageId}`
}

// Prefer the native UUID generator, falling back to crypto random bytes.
function createImageId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()

  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

// Return the id only when the reference is a well-formed draft image scheme.
function parseImageId(reference: string): string | undefined {
  if (!reference.startsWith(DRAFT_IMAGE_SCHEME)) return undefined
  const imageId = reference.slice(DRAFT_IMAGE_SCHEME.length)
  return IMAGE_ID_PATTERN.test(imageId) ? imageId : undefined
}

// Persist a verified Data URL and return its short reference.
function storeDraftImageDataUrl(storageKey: string, dataUrl: string): string {
  if (!SAFE_IMAGE_DATA_URL.test(dataUrl)) throw new Error('Invalid image data')

  const imageId = createImageId()
  localStorage.setItem(imageKey(storageKey, imageId), dataUrl)
  return `${DRAFT_IMAGE_SCHEME}${imageId}`
}

// Read an image file into a Data URL, rejecting unexpected content.
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string' && SAFE_IMAGE_DATA_URL.test(reader.result)) {
        resolve(reader.result)
      } else {
        reject(new Error('Invalid image data'))
      }
    }
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read image'))
    reader.readAsDataURL(file)
  })
}

/**
 * Store image bytes separately from Markdown and return a short, durable reference.
 * This keeps base64 data out of the textarea while preserving the local-only draft.
 */
export async function saveDraftImage(storageKey: string, file: File): Promise<string> {
  const dataUrl = await readAsDataUrl(file)
  return storeDraftImageDataUrl(storageKey, dataUrl)
}

/**
 * Replace legacy inline Data URL images with short references. Existing drafts
 * are migrated on load so old large lines stop affecting source editing.
 */
export function migrateInlineDraftImages(storageKey: string, markdown: string): string {
  return markdown.replace(
    /(!\[[^\]\r\n]*\]\()(data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\r\n]+)(\))/gi,
    (_match, prefix: string, dataUrl: string, suffix: string) => {
      try {
        const reference = storeDraftImageDataUrl(storageKey, dataUrl.replace(/[\r\n]/g, ''))
        return `${prefix}${reference}${suffix}`
      } catch {
        // Keep the original image usable if storage is full or unavailable.
        return `${prefix}${dataUrl}${suffix}`
      }
    }
  )
}

/** Resolve a short draft image reference for preview without exposing other storage keys. */
export function resolveDraftImage(storageKey: string, reference: string): string | undefined {
  const imageId = parseImageId(reference)
  if (!imageId) return undefined

  try {
    const dataUrl = localStorage.getItem(imageKey(storageKey, imageId)) ?? ''
    return SAFE_IMAGE_DATA_URL.test(dataUrl) ? dataUrl : undefined
  } catch {
    return undefined
  }
}

/** Collect every image referenced by the Markdown into submission-ready DTOs. */
export function collectDraftImages(storageKey: string, markdown: string): DiaryImageInputDTO[] {
  const references = new Set(
    Array.from(markdown.matchAll(/draft-image:\/\/([a-zA-Z0-9_-]{1,80})/g), (match) => match[1])
  )
  const images: DiaryImageInputDTO[] = []
  for (const imageId of references) {
    const reference = `${DRAFT_IMAGE_SCHEME}${imageId}`
    const dataUrl = resolveDraftImage(storageKey, reference)
    if (!dataUrl) throw new Error('A referenced draft image is missing or invalid')
    const mimeType = /^data:(image\/(?:png|jpeg|gif|webp));base64,/i
      .exec(dataUrl)?.[1]
      ?.toLowerCase()
    if (!mimeType) throw new Error('A referenced draft image is unsupported')
    images.push({
      reference,
      mimeType: mimeType as DiaryImageInputDTO['mimeType'],
      dataUrl
    })
  }
  return images
}

/** Remove image records no longer referenced by the current Markdown draft. */
export function pruneDraftImages(storageKey: string, markdown: string): boolean {
  try {
    const retainedIds = new Set<string>()
    const references = markdown.matchAll(/draft-image:\/\/([a-zA-Z0-9_-]{1,80})/g)
    for (const match of references) retainedIds.add(match[1])

    const prefix = imageKeyPrefix(storageKey)
    const storedKeys = Array.from({ length: localStorage.length }, (_, index) =>
      localStorage.key(index)
    )

    for (const key of storedKeys) {
      if (!key?.startsWith(prefix)) continue
      const imageId = key.slice(prefix.length)
      if (!retainedIds.has(imageId)) localStorage.removeItem(key)
    }
    return true
  } catch {
    return false
  }
}

/** Remove every image belonging to a submitted or discarded draft. */
export function clearDraftImages(storageKey: string): boolean {
  return pruneDraftImages(storageKey, '')
}
