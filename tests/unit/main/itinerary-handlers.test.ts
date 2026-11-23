import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcResponse } from '../../../src/common/types'
import { createIpcEvent } from '../helpers/ipc-event'
import { setSession } from '../../../src/main/ipc/security'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  list: vi.fn(),
  listAbandoned: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
  restore: vi.fn(),
  purge: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.handle }
}))
vi.mock('../../../src/main/logger', () => ({ default: { error: vi.fn() } }))
vi.mock('../../../src/main/services/ItineraryService', () => ({
  default: class {
    list = mocks.list
    listAbandoned = mocks.listAbandoned
    get = mocks.get
    create = mocks.create
    update = mocks.update
    softDelete = mocks.softDelete
    restore = mocks.restore
    purge = mocks.purge
  }
}))

import { registerItineraryHandlers } from '../../../src/main/ipc/handlers/itinerary-handlers'

/**
 * Tests itinerary IPC handlers: channel registration, session gating, and
 * passing the main-process identity plus validated payloads to the service.
 */
type Handler = (event: IpcMainInvokeEvent, args: unknown) => Promise<IpcResponse<unknown>>
const handlers = new Map<string, Handler>()

const payload = {
  name: '周末漫游',
  startTime: '2026-11-12T09:00:00.000Z',
  places: [{ name: '家' }, { name: '公司' }],
  legs: [{ mode: 'car', durationMinutes: 30 }]
}

beforeEach(() => {
  vi.resetAllMocks()
  handlers.clear()
  mocks.handle.mockImplementation((channel: string, handler: Handler) =>
    handlers.set(channel, handler)
  )
  registerItineraryHandlers()
})

function invoke(channel: string, event: IpcMainInvokeEvent, args: unknown = undefined) {
  return handlers.get(channel)!(event, args)
}

function authenticatedEvent(userId = 42) {
  const source = createIpcEvent()
  setSession(source.event, userId)
  return source
}

describe('itinerary handlers', () => {
  it('registers every itinerary channel', () => {
    expect([...handlers.keys()]).toEqual([
      'itinerary:list',
      'itinerary:abandoned',
      'itinerary:get',
      'itinerary:create',
      'itinerary:update',
      'itinerary:delete',
      'itinerary:restore',
      'itinerary:purge'
    ])
  })

  it('requires authentication before any service access', async () => {
    const unauthenticated = createIpcEvent().event
    expect((await invoke('itinerary:list', unauthenticated)).code).toBe('AUTH_REQUIRED')
    expect((await invoke('itinerary:get', unauthenticated, { itineraryId: 1 })).code).toBe(
      'AUTH_REQUIRED'
    )
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.get).not.toHaveBeenCalled()
  })

  it('rejects untrusted senders before service access', async () => {
    expect((await invoke('itinerary:list', createIpcEvent(undefined, false).event)).code).toBe(
      'IPC_FORBIDDEN'
    )
  })

  it('uses the main-process session identity when creating an itinerary', async () => {
    const source = authenticatedEvent(42)
    mocks.create.mockResolvedValue({ id: 1, ...payload, places: [], legs: [] })

    await invoke('itinerary:create', source.event, payload)
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith(42, payload, expect.any(Function))
  })

  it('passes validated itinerary ids for get/delete/restore/purge', async () => {
    const source = authenticatedEvent(42)
    mocks.get.mockResolvedValue({ id: 7, ...payload, places: [], legs: [] })
    mocks.softDelete.mockResolvedValue(true)
    mocks.restore.mockResolvedValue(true)
    mocks.purge.mockResolvedValue(true)

    await invoke('itinerary:get', source.event, { itineraryId: 7 })
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(42, 7, expect.any(Function))

    await invoke('itinerary:delete', source.event, { itineraryId: 7 })
    expect(mocks.softDelete).toHaveBeenCalledExactlyOnceWith(42, 7, expect.any(Function))

    await invoke('itinerary:restore', source.event, { itineraryId: 7 })
    expect(mocks.restore).toHaveBeenCalledExactlyOnceWith(42, 7, expect.any(Function))

    await invoke('itinerary:purge', source.event, { itineraryId: 7 })
    expect(mocks.purge).toHaveBeenCalledExactlyOnceWith(42, 7, expect.any(Function))
  })

  it('rejects a renderer-supplied itinerary id that fails validation', async () => {
    const source = authenticatedEvent(42)
    const response = await invoke('itinerary:get', source.event, { itineraryId: 0 })
    expect(response).toMatchObject({ success: false, code: 'INVALID_INPUT' })
    expect(mocks.get).not.toHaveBeenCalled()
  })

  it('normalizes unexpected service failures without leaking details', async () => {
    const source = authenticatedEvent()
    mocks.list.mockRejectedValue(new Error('private SQL and file paths'))
    const response = await invoke('itinerary:list', source.event)
    expect(response).toMatchObject({ success: false, code: 'INTERNAL_ERROR' })
    expect(JSON.stringify(response)).not.toContain('private')
  })
})
