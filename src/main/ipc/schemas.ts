/**
 * Zod schemas validating the payload of every IPC channel, including size and
 * format rules shared with the renderer.
 */
import { z } from 'zod'
import { isValidPlaintextPassword } from '../../common/password'
import {
  NOTEBOOK_NAME_MAX_LENGTH,
  NOTEBOOK_NAME_MIN_LENGTH,
  isValidNotebookPassword
} from '../../common/notebook-password'
import {
  DIARY_IMAGE_MAX_BYTES,
  DIARY_IMAGES_MAX_BYTES,
  DIARY_MARKDOWN_MAX_BYTES,
  DIARY_MAX_IMAGES
} from '../../common/diary-limits'
import {
  TRANSPORT_MODE_VALUES,
  ITINERARY_NAME_MAX_LENGTH,
  ITINERARY_MIN_PLACES,
  ITINERARY_MAX_PLACES,
  ITINERARY_MAX_DURATION_MINUTES,
  ITINERARY_MAX_STAY_MINUTES
} from '../../common/itinerary'
import { DIARY_PAGE_SIZE_DEFAULT, DIARY_PAGE_SIZE_MAX } from '../../common/diary'
import {
  PHOTOWALL_MAX_IMAGES,
  PHOTOWALL_IMAGE_HARD_MAX_BYTES,
  PHOTOWALL_IMAGE_MIN_BYTES,
  PHOTOWALL_TOTAL_MAX_BYTES,
  PHOTOWALL_TOTAL_HARD_MAX_BYTES,
  PHOTOWALL_PREVIEW_PAGE_SIZE,
  PHOTOWALL_PORTRAIT_MAX_BYTES,
  PHOTOWALL_BATCH_MAX_BYTES,
  PHOTOWALL_MIN_IMAGES_MAX,
  PHOTOWALL_MIN_IMAGES_MIN
} from '../../common/photowall'

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const notebookPassword = z
  .string()
  .max(128)
  .refine(isValidNotebookPassword, 'Password must be 8–128 characters and at most 256 UTF-8 bytes')
// const isoDateTime = z.string().datetime({ offset: true }) // deprecated
const isoDateTime = z.iso.datetime({ offset: true })
const markdown = z
  .string()
  .max(DIARY_MARKDOWN_MAX_BYTES)
  .refine(
    (value) =>
      value.length <= DIARY_MARKDOWN_MAX_BYTES &&
      Buffer.byteLength(value, 'utf8') <= DIARY_MARKDOWN_MAX_BYTES,
    'Diary content is too large'
  )
const draftImageReference = z.string().regex(/^draft-image:\/\/[A-Za-z0-9_-]{1,80}$/)
const imageMimeType = z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
// Upper bound for a base64 data URL: 4/3 expansion of the max byte size plus header overhead.
const maxImageDataUrlLength = Math.ceil(DIARY_IMAGE_MAX_BYTES / 3) * 4 + 64

function encodedImageBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0 || comma > 64) return Number.MAX_SAFE_INTEGER
  const length = dataUrl.length - comma - 1
  const padding = dataUrl.endsWith('==') ? 2 : dataUrl.endsWith('=') ? 1 : 0
  return Math.max(0, (length / 4) * 3 - padding)
}

function diaryImageBudget(
  input: { images: Array<{ dataUrl: string }> },
  context: z.RefinementCtx
): void {
  let bytes = 0
  for (const image of input.images) {
    bytes += encodedImageBytes(image.dataUrl)
    if (bytes > DIARY_IMAGES_MAX_BYTES) {
      context.addIssue({ code: 'custom', path: ['images'], message: 'Diary images are too large' })
      return
    }
  }
}

/**
 * Validates a single diary image encoded as a base64 data URL with a fixed
 * reference ID and an allowed MIME type.
 */
export const DiaryImageInputSchema = z
  .object({
    reference: draftImageReference,
    mimeType: imageMimeType,
    dataUrl: z.string().max(maxImageDataUrlLength)
  })
  .strict()
  .superRefine((image, context) => {
    if (!image.dataUrl.startsWith(`data:${image.mimeType};base64,`)) {
      context.addIssue({ code: 'custom', path: ['dataUrl'], message: 'Image MIME type mismatch' })
    }
  })

/** Payload for creating a password-protected notebook. */
export const CreateNotebookSchema = z
  .object({
    name: z.string().trim().min(NOTEBOOK_NAME_MIN_LENGTH).max(NOTEBOOK_NAME_MAX_LENGTH),
    password: notebookPassword
  })
  .strict()

/** Payload for unlocking a notebook with its password. */
export const UnlockNotebookSchema = z
  .object({ notebookId: positiveId, password: notebookPassword })
  .strict()

/** Payload identifying a single notebook. */
export const NotebookIdSchema = z.object({ notebookId: positiveId }).strict()

/** Paged read: constrain page multiplication up front to avoid OFFSET integer overflow. */
export const ListDiaryPageSchema = z
  .object({
    notebookId: positiveId,
    page: z
      .number()
      .int()
      .min(1)
      .max(Math.floor(Number.MAX_SAFE_INTEGER / DIARY_PAGE_SIZE_MAX))
      .default(1),
    pageSize: z.number().int().min(1).max(DIARY_PAGE_SIZE_MAX).default(DIARY_PAGE_SIZE_DEFAULT)
  })
  .strict()

/** Payload for creating a diary entry with optional images. */
export const CreateDiarySchema = z
  .object({
    notebookId: positiveId,
    occurredAt: isoDateTime,
    markdown,
    images: z.array(DiaryImageInputSchema).max(DIARY_MAX_IMAGES)
  })
  .strict()
  .superRefine(diaryImageBudget)

/** Payload for updating an existing diary entry. */
export const UpdateDiarySchema = z
  .object({
    notebookId: positiveId,
    diaryId: positiveId,
    occurredAt: isoDateTime,
    markdown,
    images: z.array(DiaryImageInputSchema).max(DIARY_MAX_IMAGES)
  })
  .strict()
  .superRefine(diaryImageBudget)

/** Payload identifying a diary entry within a notebook. */
export const DiaryIdSchema = z.object({ notebookId: positiveId, diaryId: positiveId }).strict()

/** Payload for exporting selected diary entries to an encrypted backup. */
export const ExportDiaryBackupSchema = z
  .object({
    notebookId: positiveId,
    diaryIds: z.array(positiveId).max(1_000).optional()
  })
  .strict()
  .superRefine((input, context) => {
    if (input.diaryIds && new Set(input.diaryIds).size !== input.diaryIds.length) {
      context.addIssue({ code: 'custom', path: ['diaryIds'], message: 'Diary IDs must be unique' })
    }
  })

/** Payload for importing an encrypted backup, protected by its password. */
export const ImportDiaryBackupSchema = z.object({ password: notebookPassword }).strict()

/** User account password: 8–30 characters, at most 72 UTF-8 bytes (bcrypt's limit). */
const password = z
  .string()
  .max(30)
  .refine(isValidPlaintextPassword, 'Password must be 8–30 characters and at most 72 UTF-8 bytes')

/** Payload for registering a new user account. */
export const CreateUserSchema = z.object({
  name: z.string().min(2, 'Name is too short').max(20),
  email: z.email('Invalid email format').max(254),
  password
})

/** Payload for authenticating an existing user. */
export const LoginSchema = z.object({
  email: z.email().max(254),
  password,
  rememberAccount: z.boolean().optional()
})

/** Saved credentials remain inside main; the renderer selects only the email. */
export const RememberedLoginSchema = LoginSchema.pick({
  email: true,
  rememberAccount: true
}).strict()

export type CreateUserInput = z.infer<typeof CreateUserSchema>

// ---- Itinerary planning ----
const transportMode = z.enum(TRANSPORT_MODE_VALUES)
const itineraryName = z.string().trim().min(1).max(ITINERARY_NAME_MAX_LENGTH)
const itineraryPlace = z
  .object({
    name: z.string().trim().min(1).max(ITINERARY_NAME_MAX_LENGTH),
    stayMinutes: z.number().int().min(0).max(ITINERARY_MAX_STAY_MINUTES).optional()
  })
  .strict()
const itineraryLeg = z
  .object({
    mode: transportMode,
    durationMinutes: z.number().int().min(1).max(ITINERARY_MAX_DURATION_MINUTES)
  })
  .strict()

/** Itinerary shape: place and leg counts must match. */
const itineraryBody = z
  .object({
    name: itineraryName,
    startTime: isoDateTime,
    places: z.array(itineraryPlace).min(ITINERARY_MIN_PLACES).max(ITINERARY_MAX_PLACES),
    legs: z
      .array(itineraryLeg)
      .min(ITINERARY_MIN_PLACES - 1)
      .max(ITINERARY_MAX_PLACES - 1)
  })
  .strict()
  .superRefine((input, context) => {
    if (input.legs.length !== input.places.length - 1) {
      context.addIssue({
        code: 'custom',
        path: ['legs'],
        message: 'Legs must connect every consecutive place'
      })
    }
  })

/** Payload for creating an itinerary. */
export const CreateItinerarySchema = itineraryBody

/** Payload for updating an existing itinerary. */
export const UpdateItinerarySchema = itineraryBody.safeExtend({
  itineraryId: positiveId
})

/** Payload identifying a single itinerary. */
export const ItineraryIdSchema = z.object({ itineraryId: positiveId }).strict()

// ---- Photo wall ----
function imageDataUrlSchema(maxBytes: number): z.ZodType<string> {
  const maxLength = Math.ceil(maxBytes / 3) * 4 + 64
  return z
    .string()
    .max(maxLength)
    .refine((value) => {
      if (
        value.length > maxLength ||
        !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
      )
        return false
      const encodedLength = value.length - value.indexOf(',') - 1
      return encodedLength % 4 === 0 && encodedImageBytes(value) <= maxBytes
    }, 'Invalid or oversized image')
}
const photoDataUrl = imageDataUrlSchema(PHOTOWALL_IMAGE_HARD_MAX_BYTES)
const portraitDataUrl = imageDataUrlSchema(PHOTOWALL_PORTRAIT_MAX_BYTES)

/** Payload for batch-adding photos to the wall. */
export const AddPhotosSchema = z
  .object({ dataUrls: z.array(photoDataUrl).min(1).max(PHOTOWALL_MAX_IMAGES) })
  .strict()
  .superRefine((input, context) => {
    let bytes = 0
    for (const value of input.dataUrls) {
      bytes += encodedImageBytes(value)
      if (bytes > PHOTOWALL_BATCH_MAX_BYTES) {
        context.addIssue({
          code: 'custom',
          path: ['dataUrls'],
          message: 'Photo batch is too large'
        })
        return
      }
    }
  })

/** The paged thumbnail query accepts no account id, file path, or image data. */
export const PhotoWallPhotoPageSchema = z
  .object({
    afterId: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(PHOTOWALL_PREVIEW_PAGE_SIZE)
      .default(PHOTOWALL_PREVIEW_PAGE_SIZE)
  })
  .strict()

/** Capacity settings are persisted in whole MiB; the renderer cannot pass an unlimited value or raise the hard cap. */
export const PhotoWallLimitsSchema = z
  .object({
    imageMaxBytes: z
      .number()
      .int()
      .min(PHOTOWALL_IMAGE_MIN_BYTES)
      .max(PHOTOWALL_IMAGE_HARD_MAX_BYTES)
      .multipleOf(1024 * 1024),
    totalMaxBytes: z
      .number()
      .int()
      .min(PHOTOWALL_TOTAL_MAX_BYTES)
      .max(PHOTOWALL_TOTAL_HARD_MAX_BYTES)
      .multipleOf(1024 * 1024)
  })
  .strict()

/** Payload for changing the minimum photo count. */
export const SetMinImagesSchema = z
  .object({
    minImages: z.number().int().min(PHOTOWALL_MIN_IMAGES_MIN).max(PHOTOWALL_MIN_IMAGES_MAX)
  })
  .strict()

/** Payload for setting (or clearing) the portrait image. */
export const SetPortraitSchema = z.object({ dataUrl: portraitDataUrl.nullable() }).strict()

/** Payload for toggling rounded corners on the wall images. */
export const SetRoundedSchema = z.object({ rounded: z.boolean() }).strict()

/** Payload for deleting a single photo. */
export const PhotoWallImageIdSchema = z.object({ imageId: positiveId }).strict()
