/**
 * IPC handlers for the notebook lifecycle: create, list, unlock, and lock.
 * Each handler enforces a session and wipes the returned data key after use.
 */
import { ipcMain } from 'electron'
import { z } from 'zod'
import { CreateNotebookSchema, NotebookIdSchema, UnlockNotebookSchema } from '../schemas'
import { handleRevocation, handleWithValidation } from '../validator'
import { captureNotebookOperation, captureSession, lockNotebook, unlockNotebook } from '../security'
import NotebookService from '../../services/NotebookService'

const notebooks = new NotebookService()

/**
 * Registers notebook IPC handlers on the Electron main process.
 */
export function registerNotebookHandlers(): void {
  ipcMain.handle(
    'notebook:create',
    handleWithValidation(
      CreateNotebookSchema,
      async (data, event) => {
        const { userId, assertActive } = captureSession(event)
        const created = await notebooks.create(userId, data.name, data.password, assertActive)
        try {
          unlockNotebook(event, created.dto.id, created.dataKey, assertActive)
          return created.dto
        } finally {
          created.dataKey.fill(0)
        }
      },
      {
        requireAuth: true,
        maxPayloadBytes: 16 * 1024,
        rateLimit: { bucket: 'notebook:create', maxRequests: 4, windowMs: 60_000 }
      }
    )
  )

  ipcMain.handle(
    'notebook:list',
    handleWithValidation(
      z.undefined(),
      async (_data, event) => {
        const { userId, assertActive } = captureSession(event)
        return notebooks.list(userId, assertActive)
      },
      { requireAuth: true }
    )
  )

  ipcMain.handle(
    'notebook:unlock',
    handleWithValidation(
      UnlockNotebookSchema,
      async (data, event) => {
        const { userId, assertActive } = captureNotebookOperation(event, data.notebookId)
        const result = await notebooks.unlock(userId, data.notebookId, data.password, assertActive)
        try {
          unlockNotebook(event, result.dto.id, result.dataKey, assertActive)
          return result.dto
        } finally {
          result.dataKey.fill(0)
        }
      },
      {
        requireAuth: true,
        maxPayloadBytes: 16 * 1024,
        rateLimit: { bucket: 'notebook:unlock', maxRequests: 8, windowMs: 60_000 }
      }
    )
  )

  ipcMain.handle(
    'notebook:lock',
    handleRevocation(NotebookIdSchema, (data, event) => {
      lockNotebook(event, data.notebookId)
      return null
    })
  )
}
