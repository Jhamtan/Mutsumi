/**
 * IPC handlers for window close behavior: reading and updating the persisted
 * preference, and resolving the renderer close dialog's choice.
 */
import { ipcMain } from 'electron'
import { z } from 'zod'
import { handleWithValidation } from '../validator'
import { getCloseBehavior, setCloseAction, resolveClose } from '../../window/window-control'

const CloseActionSchema = z.enum(['tray', 'quit'])

/** Registers the window-control IPC channels. Call once during app startup. */
export function registerWindowHandlers(): void {
  ipcMain.handle(
    'window:get-close-behavior',
    handleWithValidation(z.undefined(), async () => getCloseBehavior())
  )

  ipcMain.handle(
    'window:set-close-behavior',
    handleWithValidation(z.object({ action: CloseActionSchema }).strict(), async ({ action }) => {
      setCloseAction(action)
      return null
    })
  )

  ipcMain.handle(
    'window:resolve-close',
    handleWithValidation(
      z.object({ action: CloseActionSchema, remember: z.boolean() }).strict(),
      async ({ action, remember }) => {
        resolveClose(action, remember)
        return null
      }
    )
  )
}
