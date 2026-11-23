/**
 * IPC handler orchestrator: registers every handler module on the Electron main
 * process. Each domain (auth, notebook, diary, backup, window control) lives in
 * its own module under ./handlers.
 */
import { registerAuthHandlers } from './handlers/auth-handlers'
import { registerNotebookHandlers } from './handlers/notebook-handlers'

/**
 * Registers every IPC handler on the Electron main process.
 * Call once during app startup.
 */
export function registerIpcHandlers(): void {
  registerAuthHandlers()
  registerNotebookHandlers()
  // Remaining domains (diary, backup, window, itinerary, photo wall) are
  // registered as each feature is migrated.
}
