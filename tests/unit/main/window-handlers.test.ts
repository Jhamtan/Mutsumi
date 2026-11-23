import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerWindowHandlers } from '../../../src/main/ipc/handlers/window-handlers'
import type { IpcResponse, CloseBehaviorDTO } from '../../../src/common/types'
import { createIpcEvent } from '../helpers/ipc-event'

/**
 * Tests the window-control IPC handlers at the handler layer: channel
 * registration, payload validation, and delegation to the window-control module.
 */
const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  getCloseBehavior: vi.fn(),
  setCloseAction: vi.fn(),
  resolveClose: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../../../src/main/logger', () => ({ default: { error: vi.fn() } }))
vi.mock('../../../src/main/window/window-control', () => ({
  getCloseBehavior: mocks.getCloseBehavior,
  setCloseAction: mocks.setCloseAction,
  resolveClose: mocks.resolveClose
}))

type Handler = (event: IpcMainInvokeEvent, args: unknown) => Promise<IpcResponse<unknown>>
const handlers = new Map<string, Handler>()

beforeEach(() => {
  vi.resetAllMocks()
  handlers.clear()
  mocks.handle.mockImplementation((channel: string, handler: Handler) =>
    handlers.set(channel, handler)
  )
  registerWindowHandlers()
})

function invoke(channel: string, event: IpcMainInvokeEvent, args: unknown = undefined) {
  return handlers.get(channel)!(event, args)
}

it('registers exactly the window-control channels', () => {
  expect([...handlers.keys()].sort()).toEqual(
    ['window:get-close-behavior', 'window:set-close-behavior', 'window:resolve-close'].sort()
  )
})

describe('window:get-close-behavior', () => {
  it('returns the persisted close behavior', async () => {
    const behavior: CloseBehaviorDTO = { action: 'tray', remember: false }
    mocks.getCloseBehavior.mockReturnValue(behavior)
    expect(await invoke('window:get-close-behavior', createIpcEvent().event)).toEqual({
      success: true,
      data: behavior
    })
  })

  it('rejects unexpected arguments', async () => {
    expect((await invoke('window:get-close-behavior', createIpcEvent().event, { x: 1 })).code).toBe(
      'INVALID_INPUT'
    )
    expect(mocks.getCloseBehavior).not.toHaveBeenCalled()
  })
})

describe('window:set-close-behavior', () => {
  it.each(['tray', 'quit'])('persists the action %s', async (action) => {
    const response = await invoke('window:set-close-behavior', createIpcEvent().event, { action })
    expect(mocks.setCloseAction).toHaveBeenCalledExactlyOnceWith(action)
    expect(response).toEqual({ success: true, data: null })
  })

  it('rejects invalid actions and unexpected keys', async () => {
    expect(
      (await invoke('window:set-close-behavior', createIpcEvent().event, { action: 'close' })).code
    ).toBe('INVALID_INPUT')
    expect(
      (
        await invoke('window:set-close-behavior', createIpcEvent().event, {
          action: 'tray',
          extra: 1
        })
      ).code
    ).toBe('INVALID_INPUT')
    expect(mocks.setCloseAction).not.toHaveBeenCalled()
  })
})

describe('window:resolve-close', () => {
  it('delegates the chosen action and remember flag', async () => {
    const response = await invoke('window:resolve-close', createIpcEvent().event, {
      action: 'quit',
      remember: true
    })
    expect(mocks.resolveClose).toHaveBeenCalledExactlyOnceWith('quit', true)
    expect(response).toEqual({ success: true, data: null })
  })

  it('rejects a missing remember flag', async () => {
    expect(
      (await invoke('window:resolve-close', createIpcEvent().event, { action: 'tray' })).code
    ).toBe('INVALID_INPUT')
    expect(mocks.resolveClose).not.toHaveBeenCalled()
  })
})

it.each(['window:get-close-behavior', 'window:set-close-behavior', 'window:resolve-close'])(
  'rejects untrusted senders for %s',
  async (channel) => {
    expect((await invoke(channel, createIpcEvent(undefined, false).event)).code).toBe(
      'IPC_FORBIDDEN'
    )
  }
)
