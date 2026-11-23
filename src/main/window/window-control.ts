/**
 * Window lifecycle control: persists the "close behavior" preference (minimize
 * to tray vs. quit) and centralizes the show/hide/quit actions shared by the
 * system tray icon, the window close handler, and the renderer close dialog.
 */
import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import Store from 'electron-store'
import type { CloseAction } from '../../common/types'

/** Persisted close behavior: which action to take and whether it is remembered. */
interface CloseBehavior {
  action: CloseAction
  remember: boolean
}

let mainWindow: BrowserWindow | null = null
let store: Store<CloseBehavior> | undefined

function getStore(): Store<CloseBehavior> {
  store ??= new Store<CloseBehavior>({
    name: 'close-behavior',
    defaults: { action: 'tray', remember: false }
  })
  return store
}

/** Registers the main window so lifecycle actions can target it. */
export function bindWindow(win: BrowserWindow): void {
  mainWindow = win
}

/** Returns the persisted close behavior (defaults to tray, not remembered). */
export function getCloseBehavior(): CloseBehavior {
  return { ...getStore().store }
}

/** Persists only the close action, leaving the "remember" flag untouched. */
export function setCloseAction(action: CloseAction): void {
  getStore().set('action', action)
}

/**
 * Applies the choice made in the close dialog. When "remember" is set the
 * choice is persisted so subsequent closes skip the dialog entirely.
 */
export function resolveClose(action: CloseAction, remember: boolean): void {
  if (remember) getStore().set({ action, remember: true })
  applyCloseAction(action)
}

/**
 * Intercepts the window "close" event: when the behavior is remembered it acts
 * immediately (hide to tray or quit); otherwise it asks the renderer to show
 * the close dialog, forwarding the current default action.
 */
export function handleClose(event: Electron.Event): void {
  event.preventDefault()
  const { action, remember } = getCloseBehavior()
  if (remember) {
    applyCloseAction(action)
    return
  }
  mainWindow?.webContents.send('app:close-query', action)
}

/** Shows and focuses the main window, restoring it from the tray if minimized. */
export function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** Hides the main window to the system tray. */
export function hideMainWindow(): void {
  mainWindow?.hide()
}

/** Quits the application through the normal before-quit cleanup path. */
export function quitApplication(): void {
  app.quit()
}

function applyCloseAction(action: CloseAction): void {
  if (action === 'quit') app.quit()
  else mainWindow?.hide()
}
