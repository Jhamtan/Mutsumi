import { describe, expect, it } from 'vitest'
import {
  CreateDiarySchema,
  CreateNotebookSchema,
  ExportDiaryBackupSchema,
  UpdateDiarySchema
} from '../../../src/main/ipc/schemas'

/**
 * Validates diary/notebook/backup IPC schemas: canonical timestamps, image
 * references, notebook password rules, and duplicate backup selection.
 */
const png = 'data:image/png;base64,iVBORw0KGgo='
const diary = {
  notebookId: 1,
  occurredAt: '2026-10-28T12:30:00.000Z',
  markdown: '![image](draft-image://one)',
  images: [{ reference: 'draft-image://one', mimeType: 'image/png', dataUrl: png }]
}

describe('diary IPC schemas', () => {
  it('accepts the canonical UTC timestamp and bounded draft images', () => {
    expect(CreateDiarySchema.safeParse(diary).success).toBe(true)
    expect(UpdateDiarySchema.safeParse({ ...diary, diaryId: 2 }).success).toBe(true)
  })

  it.each([
    { ...diary, notebookId: 0 },
    { ...diary, occurredAt: '2026-10-28 12:30' },
    { ...diary, images: [{ ...diary.images[0], mimeType: 'image/svg+xml' }] },
    { ...diary, images: [{ ...diary.images[0], reference: '../image' }] },
    { ...diary, userId: 99 }
  ])('rejects malformed or contract-breaking diary data: %#', (input) => {
    expect(CreateDiarySchema.safeParse(input).success).toBe(false)
  })

  it('validates notebook passwords separately from login passwords', () => {
    // Notebook passwords have their own length rules, distinct from account login.
    expect(
      CreateNotebookSchema.safeParse({ name: 'Journal', password: 'long-password' }).success
    ).toBe(true)
    expect(CreateNotebookSchema.safeParse({ name: 'Journal', password: 'short' }).success).toBe(
      false
    )
  })

  it('rejects duplicate backup selections', () => {
    expect(ExportDiaryBackupSchema.safeParse({ notebookId: 1, diaryIds: [1, 2] }).success).toBe(
      true
    )
    expect(ExportDiaryBackupSchema.safeParse({ notebookId: 1, diaryIds: [1, 1] }).success).toBe(
      false
    )
  })
})
