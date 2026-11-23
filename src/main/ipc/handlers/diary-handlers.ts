/**
 * IPC handlers for diary entries. Reads and writes require the notebook to be
 * unlocked; the user ID is always taken from the session, never from the request.
 */
import { ipcMain } from 'electron'
import {
  CreateDiarySchema,
  DiaryIdSchema,
  ListDiaryPageSchema,
  NotebookIdSchema,
  UpdateDiarySchema
} from '../schemas'
import { handleWithValidation } from '../validator'
import { withUnlockedNotebook } from '../security'
import { DIARY_IMAGES_MAX_BYTES, DIARY_MARKDOWN_MAX_BYTES } from '@common/diary-limits'
import DiaryService from '../../services/DiaryService'

const diaries = new DiaryService()
const writePolicy = {
  requireAuth: true,
  maxPayloadBytes: Math.ceil(DIARY_IMAGES_MAX_BYTES / 3) * 4 + DIARY_MARKDOWN_MAX_BYTES + 64 * 1024,
  rateLimit: { bucket: 'diary:write', maxRequests: 12, windowMs: 60_000 }
}

/**
 * Registers diary IPC handlers on the Electron main process.
 */
export function registerDiaryHandlers(): void {
  ipcMain.handle(
    'diary:list',
    handleWithValidation(
      NotebookIdSchema,
      async (data, event) => {
        return withUnlockedNotebook(event, data.notebookId, (userId, key, guard) =>
          diaries.list(userId, data.notebookId, key, guard)
        )
      },
      { requireAuth: true }
    )
  )

  ipcMain.handle(
    'diary:get',
    handleWithValidation(
      DiaryIdSchema,
      async (data, event) => {
        return withUnlockedNotebook(event, data.notebookId, (userId, key, guard) =>
          diaries.get(userId, data.notebookId, data.diaryId, key, guard)
        )
      },
      { requireAuth: true }
    )
  )

  ipcMain.handle(
    'diary:create',
    handleWithValidation(
      CreateDiarySchema,
      async (data, event) => {
        return withUnlockedNotebook(event, data.notebookId, (userId, key, guard) =>
          diaries.create(userId, data, key, guard)
        )
      },
      writePolicy
    )
  )

  ipcMain.handle(
    'diary:update',
    handleWithValidation(
      UpdateDiarySchema,
      async (data, event) => {
        return withUnlockedNotebook(event, data.notebookId, (userId, key, guard) =>
          diaries.update(userId, data, key, guard)
        )
      },
      writePolicy
    )
  )

  ipcMain.handle(
    'diary:delete',
    handleWithValidation(
      DiaryIdSchema,
      async (data, event) => {
        return withUnlockedNotebook(event, data.notebookId, (userId, _key, guard) =>
          diaries.delete(userId, data.notebookId, data.diaryId, guard)
        )
      },
      { requireAuth: true }
    )
  )

  ipcMain.handle(
    'diary:list-page',
    handleWithValidation(
      ListDiaryPageSchema,
      async (data, event) =>
        withUnlockedNotebook(event, data.notebookId, (userId, key, guard) =>
          diaries.listPage(
            userId,
            data.notebookId,
            key,
            { page: data.page, pageSize: data.pageSize },
            guard
          )
        ),
      { requireAuth: true, maxPayloadBytes: 4 * 1024 }
    )
  )
}
