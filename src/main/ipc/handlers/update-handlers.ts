/**
 * IPC handlers for application updates: reading app metadata and the
 * auto-check preference, triggering a manual check, and installing a
 * downloaded update.
 */
import { ipcMain } from 'electron'
import { z } from 'zod'
import { handleWithValidation } from '../validator'
import {
  checkForUpdates,
  getAppInfo,
  getAutoCheck,
  getUpdateStatus,
  installUpdate,
  setAutoCheck
} from '../../updater'

const SetAutoCheckSchema = z.object({ autoCheck: z.boolean() }).strict()

/** Registers the update-related IPC channels. Call once during app startup. */
export function registerUpdateHandlers(): void {
  ipcMain.handle(
    'update:get-info',
    handleWithValidation(z.undefined(), async () => getAppInfo())
  )

  ipcMain.handle(
    'update:get-status',
    handleWithValidation(z.undefined(), async () => getUpdateStatus())
  )

  ipcMain.handle(
    'update:get-settings',
    handleWithValidation(z.undefined(), async () => ({ autoCheck: getAutoCheck() }))
  )

  ipcMain.handle(
    'update:set-auto-check',
    handleWithValidation(SetAutoCheckSchema, async ({ autoCheck }) => {
      setAutoCheck(autoCheck)
      return null
    })
  )

  ipcMain.handle(
    'update:check',
    handleWithValidation(z.undefined(), async () => checkForUpdates())
  )

  ipcMain.handle(
    'update:install',
    handleWithValidation(z.undefined(), async () => {
      installUpdate()
      return null
    })
  )
}
