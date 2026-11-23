import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerIpcHandlers } from '../../../src/main/ipc/handlers'

/**
 * Tests the IPC orchestrator: it delegates registration to every domain handler
 * module without registering channels of its own.
 */
const mocks = vi.hoisted(() => ({
  registerAuthHandlers: vi.fn(),
  registerNotebookHandlers: vi.fn(),
  registerDiaryHandlers: vi.fn(),
  registerBackupHandlers: vi.fn(),
  registerWindowHandlers: vi.fn(),
  registerItineraryHandlers: vi.fn(),
  registerPhotoWallHandlers: vi.fn()
}))

vi.mock('../../../src/main/ipc/handlers/auth-handlers', () => ({
  registerAuthHandlers: mocks.registerAuthHandlers
}))
vi.mock('../../../src/main/ipc/handlers/notebook-handlers', () => ({
  registerNotebookHandlers: mocks.registerNotebookHandlers
}))
vi.mock('../../../src/main/ipc/handlers/diary-handlers', () => ({
  registerDiaryHandlers: mocks.registerDiaryHandlers
}))
vi.mock('../../../src/main/ipc/handlers/backup-handlers', () => ({
  registerBackupHandlers: mocks.registerBackupHandlers
}))
vi.mock('../../../src/main/ipc/handlers/window-handlers', () => ({
  registerWindowHandlers: mocks.registerWindowHandlers
}))
vi.mock('../../../src/main/ipc/handlers/itinerary-handlers', () => ({
  registerItineraryHandlers: mocks.registerItineraryHandlers
}))
vi.mock('../../../src/main/ipc/handlers/photowall-handlers', () => ({
  registerPhotoWallHandlers: mocks.registerPhotoWallHandlers
}))

beforeEach(() => {
  vi.resetAllMocks()
  registerIpcHandlers()
})

describe('registerIpcHandlers', () => {
  it('delegates to every handler module exactly once', () => {
    expect(mocks.registerAuthHandlers).toHaveBeenCalledTimes(1)
    expect(mocks.registerNotebookHandlers).toHaveBeenCalledTimes(1)
    expect(mocks.registerDiaryHandlers).toHaveBeenCalledTimes(1)
    expect(mocks.registerBackupHandlers).toHaveBeenCalledTimes(1)
    expect(mocks.registerWindowHandlers).toHaveBeenCalledTimes(1)
    expect(mocks.registerItineraryHandlers).toHaveBeenCalledTimes(1)
    expect(mocks.registerPhotoWallHandlers).toHaveBeenCalledTimes(1)
  })
})
