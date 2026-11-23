import { describe, expect, it } from 'vitest'
import {
  AddPhotosSchema,
  PhotoWallImageIdSchema,
  SetMinImagesSchema,
  SetRoundedSchema,
  SetPortraitSchema
} from '../../../src/main/ipc/schemas'

/**
 * Validates the photo wall Zod schemas: data-URL format, batch size bounds,
 * minimum-count range and the nullable portrait payload.
 */
const dataUrl = 'data:image/jpeg;base64,AAAA'

describe('AddPhotosSchema', () => {
  it('accepts a batch of valid image data URLs', () => {
    expect(AddPhotosSchema.safeParse({ dataUrls: [dataUrl, dataUrl] }).success).toBe(true)
  })

  it.each(['', 'http://x/y.png', 'data:text/plain;base64,AAAA', 'data:image/svg+xml;base64,AA=='])(
    'rejects a non-image data URL: %j',
    (url) => {
      expect(AddPhotosSchema.safeParse({ dataUrls: [url] }).success).toBe(false)
    }
  )

  it('rejects an empty or oversized batch', () => {
    expect(AddPhotosSchema.safeParse({ dataUrls: [] }).success).toBe(false)
    expect(AddPhotosSchema.safeParse({ dataUrls: Array(201).fill(dataUrl) }).success).toBe(false)
  })

  it('strips unknown fields', () => {
    expect(AddPhotosSchema.safeParse({ dataUrls: [dataUrl], id: 9 }).success).toBe(false)
  })
})

describe('SetMinImagesSchema', () => {
  it('accepts a value within the supported range', () => {
    expect(SetMinImagesSchema.safeParse({ minImages: 2 }).success).toBe(true)
    expect(SetMinImagesSchema.safeParse({ minImages: 10 }).success).toBe(true)
    expect(SetMinImagesSchema.safeParse({ minImages: 100 }).success).toBe(true)
  })

  it.each([1, 101, 3.5, -1])('rejects an out-of-range or non-integer value: %j', (value) => {
    expect(SetMinImagesSchema.safeParse({ minImages: value }).success).toBe(false)
  })
})

describe('SetPortraitSchema', () => {
  it('accepts a valid data URL or null', () => {
    expect(SetPortraitSchema.safeParse({ dataUrl }).success).toBe(true)
    expect(SetPortraitSchema.safeParse({ dataUrl: null }).success).toBe(true)
  })

  it('rejects a non-image data URL', () => {
    expect(SetPortraitSchema.safeParse({ dataUrl: 'data:text/plain;base64,AAAA' }).success).toBe(
      false
    )
  })
})

describe('SetRoundedSchema', () => {
  it('accepts a boolean', () => {
    expect(SetRoundedSchema.safeParse({ rounded: true }).success).toBe(true)
    expect(SetRoundedSchema.safeParse({ rounded: false }).success).toBe(true)
  })

  it.each(['yes', 1, null, undefined])('rejects a non-boolean value: %j', (value) => {
    expect(SetRoundedSchema.safeParse({ rounded: value }).success).toBe(false)
  })
})

describe('PhotoWallImageIdSchema', () => {
  it('accepts a positive id and rejects missing or invalid ids', () => {
    expect(PhotoWallImageIdSchema.safeParse({ imageId: 1 }).success).toBe(true)
    expect(PhotoWallImageIdSchema.safeParse({}).success).toBe(false)
    expect(PhotoWallImageIdSchema.safeParse({ imageId: 0 }).success).toBe(false)
  })
})
