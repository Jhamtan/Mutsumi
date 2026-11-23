/**
 * IPC handler orchestrator: registers every handler module on the Electron main
 * process. Each domain (auth, notebook, diary, backup, window control) lives in
 * its own module under ./handlers.
 */
import { registerAuthHandlers } from './handlers/auth-handlers'
import { registerNotebookHandlers } from './handlers/notebook-handlers'
import { registerDiaryHandlers } from './handlers/diary-handlers'
import { registerItineraryHandlers } from './handlers/itinerary-handlers'
import { registerPhotoWallHandlers } from './handlers/photowall-handlers'

/**
 * Registers every IPC handler on the Electron main process.
 * Call once during app startup.
 */
export function registerIpcHandlers(): void {
  registerAuthHandlers()
  registerNotebookHandlers()
  registerDiaryHandlers()
  registerItineraryHandlers()
  registerPhotoWallHandlers()
  // Remaining domains (backup, window) are registered as each feature is migrated.
}
