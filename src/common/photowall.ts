/**
 * Shared data models and constants for the photo wall.
 *
 * The photo wall is a singleton per user: each user owns a set of photos and an
 * optional portrait image. Photos form the upward-scrolling photo wall, while
 * the portrait image is pinned to the bottom and rendered in front of the other
 * photos. Images are transferred across processes as data URLs, which must be
 * plain JSON-serializable strings.
 */

// ---- Limit constants ----
/** Default minimum number of photos to upload. */
export const PHOTOWALL_MIN_IMAGES_DEFAULT = 10
/** Smallest allowed value for the minimum-upload count. */
export const PHOTOWALL_MIN_IMAGES_MIN = 2
/** Largest allowed value for the minimum-upload count. */
export const PHOTOWALL_MIN_IMAGES_MAX = 100
/** Maximum number of photos the wall can hold. */
export const PHOTOWALL_MAX_IMAGES = 200
/** Default per-photo cap; the user can adjust it in the photo wall settings. */
export const PHOTOWALL_IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const PHOTOWALL_IMAGE_MIN_BYTES = 1024 * 1024
/** Hard per-photo safety cap that the user cannot exceed. */
export const PHOTOWALL_IMAGE_HARD_MAX_BYTES = 10 * 1024 * 1024
/** Maximum bytes for the portrait image (keeps original clarity and transparency). */
export const PHOTOWALL_PORTRAIT_MAX_BYTES = 20 * 1024 * 1024
/** Maximum total bytes per batch of uploaded photos. */
export const PHOTOWALL_BATCH_MAX_BYTES = 25 * 1024 * 1024
/** Default combined capacity for regular photos and the portrait, not the ZIP-compressed size. */
export const PHOTOWALL_TOTAL_MAX_BYTES = 64 * 1024 * 1024
export const PHOTOWALL_TOTAL_HARD_MAX_BYTES = 512 * 1024 * 1024
/** Generate only a small page of previews at a time; originals are read only during per-image export. */
export const PHOTOWALL_PREVIEW_PAGE_SIZE = 10
export const PHOTOWALL_PREVIEW_MAX_EDGE = 640
export const PHOTOWALL_PREVIEW_MAX_BYTES = 128 * 1024

/** Photo wall image type. */
export type PhotoWallImageType = 'photo' | 'portrait'

/** Whether thumbnails and wall previews use rounded corners (no rounding by default). */
export const PHOTOWALL_ROUNDED_DEFAULT = false

/** Capacity settings persisted per account; values are file byte counts after base64 decoding. */
export interface PhotoWallLimitsDTO {
  imageMaxBytes: number
  totalMaxBytes: number
}

export interface PhotoWallUsageDTO extends PhotoWallLimitsDTO {
  usedBytes: number
}

export interface PhotoWallPhotoPageOptionsDTO {
  afterId?: number
  pageSize?: number
}

export interface PhotoWallPhotoPageDTO {
  items: PhotoWallPhotoDTO[]
  total: number
  nextCursor: number | null
}

/** Photo wall state (without full photo data, for the management page). */
export interface PhotoWallStateDTO {
  minImages: number
  photoCount: number
  /** Portrait image data URL, or null when none is uploaded. */
  portrait: string | null
  /** Whether thumbnails and wall previews use rounded corners. */
  rounded: boolean
}

/** A single photo on the wall. */
export interface PhotoWallPhotoDTO {
  id: number
  dataUrl: string
  /** SHA-256 of the original file, used for exact duplicate detection in the thumbnail list. */
  sourceHash?: string
}

/** Input for batch-adding photos. */
export interface AddPhotosDTO {
  dataUrls: string[]
}

/** Input for changing the minimum-upload count. */
export interface SetMinImagesDTO {
  minImages: number
}

/** Input for setting the portrait image; a null dataUrl removes it. */
export interface SetPortraitDTO {
  dataUrl: string | null
}

/** Input for toggling rounded corners. */
export interface SetRoundedDTO {
  rounded: boolean
}

/** Result of adding photos. */
export interface AddPhotosResultDTO {
  added: number
  photoCount: number
}

/** Result of exporting the photo wall archive. */
export interface PhotoWallExportResultDTO {
  canceled: boolean
  filePath?: string
  photoCount?: number
}
