import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { exit: vi.fn() },
  dialog: { showErrorBox: vi.fn() }
}))
vi.mock('../../../src/main/database/db', () => ({
  initDatabase: vi.fn(),
  sequelize: undefined
}))
vi.mock('../../../src/main/logger', () => ({
  default: { info: vi.fn(), error: vi.fn() },
  setupLogger: vi.fn()
}))

import { AppInitializer } from '../../../src/main/init'

/**
 * Verifies AppInitializer is a singleton. Electron and heavyweight startup
 * dependencies are mocked so importing init does not boot the application.
 */
describe('AppInitializer singleton', () => {
  it('returns the same initializer for every request', () => {
    const first = AppInitializer.getInstance()
    const second = AppInitializer.getInstance()

    expect(second).toBe(first)
  })
})
