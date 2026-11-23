/**
 * Diary/notebook data-transfer objects shared across renderer, preload and main.
 *
 * All fields are JSON-serializable (timestamps are ISO strings). The same shapes
 * are consumed by the renderer types, the preload bridge and the main-process
 * Zod schemas.
 */
export interface NotebookSummaryDTO {
  id: number
  uuid: string
  name: string
  createdAt: string
  updatedAt: string
}

/**
 * Payload for creating a notebook; `password` is the notebook encryption
 * password (validated by the notebook-password policy, not the account one).
 */
export interface CreateNotebookDTO {
  name: string
  password: string
}

/** Payload for unlocking (decrypting) a notebook with its password. */
export interface UnlockNotebookDTO {
  notebookId: number
  password: string
}

/** The diary list defaults to 20 items per page; both main and renderer cap a page at 100. */
export const DIARY_PAGE_SIZE_DEFAULT = 20
export const DIARY_PAGE_SIZE_MAX = 100

export interface DiaryPageOptionsDTO {
  page?: number
  pageSize?: number
}

export interface ListDiaryPageDTO extends DiaryPageOptionsDTO {
  notebookId: number
}

/** Pages are 1-based; requests past the last page return the actual last page, and an empty list still reports page 1. */
export interface DiaryPageDTO {
  items: DiarySummaryDTO[]
  total: number
  page: number
  pageSize: number
}

export interface DiarySummaryDTO {
  id: number
  uuid: string
  notebookId: number
  occurredAt: string
  createdAt: string
  updatedAt: string
  /**
   * Card preview populated only by the list endpoint: the first Markdown
   * heading (if any) and a truncated plain-text excerpt of the content.
   */
  title?: string
  preview?: string
}

/**
 * Image supplied by the renderer when creating/updating a diary. `reference` is
 * a draft-image URL, `mimeType` is restricted to the four supported formats and
 * `dataUrl` is a base64 data URL matching that MIME type.
 */
export interface DiaryImageInputDTO {
  reference: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  dataUrl: string
}

/** Image as returned to the renderer; `mimeType` is a plain string (not the input union). */
export interface DiaryImageDTO {
  reference: string
  mimeType: string
  dataUrl: string
}

export interface DiaryDTO extends DiarySummaryDTO {
  markdown: string
  images: DiaryImageDTO[]
}

export interface CreateDiaryDTO {
  notebookId: number
  occurredAt: string
  markdown: string
  images: DiaryImageInputDTO[]
}

export interface UpdateDiaryDTO {
  notebookId: number
  diaryId: number
  occurredAt: string
  markdown: string
  images: DiaryImageInputDTO[]
}

/**
 * Payload for exporting a notebook backup. When `diaryIds` is omitted, all of
 * the notebook's diaries are exported.
 */
export interface ExportDiaryBackupDTO {
  notebookId: number
  diaryIds?: number[]
}

/** Payload for importing a backup; `password` decrypts the backup file. */
export interface ImportDiaryBackupDTO {
  password: string
}

/**
 * Export result: `canceled` is true when the user aborted the save dialog;
 * `diaryCount` is set only when the export completed.
 */
export interface BackupExportResultDTO {
  canceled: boolean
  diaryCount?: number
}

/**
 * Import result: `canceled` is true when the user aborted the file dialog;
 * `notebook` and `diaryCount` describe the restored data on success.
 */
export interface BackupImportResultDTO {
  canceled: boolean
  notebook?: NotebookSummaryDTO
  diaryCount?: number
}
