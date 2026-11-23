/**
 * IPC handlers for encrypted diary backup export and import, driven by native
 * file dialogs. Imported backups unlock their notebook once the key is recovered.
 */
import {
  BrowserWindow,
  dialog,
  ipcMain,
  type OpenDialogOptions,
  type SaveDialogOptions
} from 'electron'
import { ExportDiaryBackupSchema, ImportDiaryBackupSchema } from '../schemas'
import { handleWithValidation } from '../validator'
import { captureSession, withUnlockedNotebook, unlockNotebook } from '../security'
import DiaryBackupService from '../../services/DiaryBackupService'

const backups = new DiaryBackupService()

/**
 * Registers backup IPC handlers on the Electron main process.
 */
export function registerBackupHandlers(): void {
  ipcMain.handle(
    'diary:backup-export',
    handleWithValidation(
      ExportDiaryBackupSchema,
      async (data, event) => {
        return withUnlockedNotebook(event, data.notebookId, async (userId, dataKey, guard) => {
          const window = BrowserWindow.fromWebContents(event.sender)
          const options: SaveDialogOptions = {
            title: 'Export diary backup',
            defaultPath: 'diary-backup.mydiary.zip',
            filters: [{ name: 'Diary backup', extensions: ['zip'] }],
            properties: ['createDirectory', 'showOverwriteConfirmation']
          }
          const selection = window
            ? await dialog.showSaveDialog(window, options)
            : await dialog.showSaveDialog(options)
          guard()
          if (selection.canceled || !selection.filePath) return { canceled: true }

          return backups.exportBackup(
            userId,
            data.notebookId,
            data.diaryIds,
            dataKey,
            selection.filePath,
            guard
          )
        })
      },
      {
        requireAuth: true,
        rateLimit: { bucket: 'backup:export', maxRequests: 4, windowMs: 60_000 }
      }
    )
  )

  ipcMain.handle(
    'diary:backup-import',
    handleWithValidation(
      ImportDiaryBackupSchema,
      async (data, event) => {
        const { userId, assertActive } = captureSession(event)
        const window = BrowserWindow.fromWebContents(event.sender)
        const options: OpenDialogOptions = {
          title: 'Import diary backup',
          filters: [{ name: 'Diary backup', extensions: ['zip'] }],
          properties: ['openFile']
        }
        const selection = window
          ? await dialog.showOpenDialog(window, options)
          : await dialog.showOpenDialog(options)
        assertActive()
        const archivePath = selection.filePaths[0]
        if (selection.canceled || !archivePath) return { canceled: true }

        const imported = await backups.importBackup(
          userId,
          data.password,
          archivePath,
          assertActive
        )
        try {
          unlockNotebook(event, imported.result.notebook!.id, imported.dataKey, assertActive)
          return imported.result
        } finally {
          imported.dataKey.fill(0)
        }
      },
      {
        requireAuth: true,
        maxPayloadBytes: 16 * 1024,
        rateLimit: { bucket: 'backup:import', maxRequests: 4, windowMs: 60_000 }
      }
    )
  )
}
