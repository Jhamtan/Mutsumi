import type { Transaction } from 'sequelize'
import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAuthHandlers } from '../../../src/main/ipc/handlers/auth-handlers'
import { AppError } from '../../../src/main/errors'
import {
  clearSession,
  requireSession,
  requireUnlockedNotebook,
  setSession,
  unlockNotebook
} from '../../../src/main/ipc/security'
import type { IpcResponse, UserDTO } from '../../../src/common/types'
import { createIpcEvent } from '../helpers/ipc-event'

/**
 * Tests the auth IPC handlers at the handler layer: channel registration,
 * transaction/rollback behavior, session management, and error redaction.
 */
const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  handle: vi.fn(),
  findByEmail: vi.fn(),
  create: vi.fn(),
  findUserForLogin: vi.fn(),
  findForSession: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../../../src/main/logger', () => ({ default: { error: vi.fn() } }))
vi.mock('../../../src/main/database/repositories/UserRepository', () => ({
  default: class {
    transaction = mocks.transaction
    findByEmail = mocks.findByEmail
    create = mocks.create
    findUserForLogin = mocks.findUserForLogin
    findForSession = mocks.findForSession
  }
}))

type Handler = (
  event: IpcMainInvokeEvent,
  args: unknown
) => IpcResponse<unknown> | Promise<IpcResponse<unknown>>
const handlers = new Map<string, Handler>()
const transaction = { id: 'registration-transaction' } as unknown as Transaction
const input = { name: 'Test User', email: 'test@example.com', password: 'password123' }
const dto: UserDTO = {
  id: 42,
  name: input.name,
  email: input.email,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

beforeEach(() => {
  vi.resetAllMocks()
  handlers.clear()
  // Capture registered channels into a local Map so tests can invoke them directly.
  mocks.handle.mockImplementation((channel: string, handler: Handler) =>
    handlers.set(channel, handler)
  )
  registerAuthHandlers()
  mocks.transaction.mockImplementation(
    (operation: (transaction: Transaction) => Promise<unknown>) => operation(transaction)
  )
  mocks.findByEmail.mockResolvedValue(null)
  mocks.create.mockResolvedValue({ toJSON: () => dto })
  mocks.findForSession.mockResolvedValue({ id: dto.id, toJSON: () => dto })
})

function invoke(channel: string, event: IpcMainInvokeEvent, args: unknown = undefined) {
  return handlers.get(channel)!(event, args)
}

it('registers exactly the public auth channels', () => {
  expect([...handlers.keys()]).toEqual([
    'user:create',
    'user:login',
    'user:session',
    'user:logout',
    'user:remembered-account',
    'user:login-remembered',
    'user:forget-remembered-account'
  ])
})

describe('user:create', () => {
  it('checks all reserved emails and returns the serialized DTO', async () => {
    const response = await invoke('user:create', createIpcEvent().event, { ...input, id: 99 })
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
    expect(mocks.findByEmail).toHaveBeenCalledExactlyOnceWith(input.email, {
      transaction,
      paranoid: false
    })
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith(input, { transaction })
    expect(response).toEqual({ success: true, data: dto })
    expect(response.data).not.toHaveProperty('password')
  })

  it('does not create an account if the email is reserved', async () => {
    mocks.findByEmail.mockResolvedValue({ id: 1 })
    expect(await invoke('user:create', createIpcEvent().event, input)).toMatchObject({
      code: 'EMAIL_EXISTS'
    })
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('normalizes concurrent duplicate errors', async () => {
    // A race where another request reserved the email first still surfaces EMAIL_EXISTS.
    mocks.create.mockRejectedValue(new AppError('Duplicate value', 'DATA_EXISTS'))
    expect(await invoke('user:create', createIpcEvent().event, input)).toEqual({
      success: false,
      code: 'EMAIL_EXISTS',
      message: 'Email already exists'
    })
  })

  it.each([
    [new AppError('Operation rejected', 'DB_REJECTED'), 'DB_REJECTED'],
    [new Error('private SQL parameters'), 'INTERNAL_ERROR']
  ])('preserves business errors and contains unexpected errors: %s', async (error, code) => {
    mocks.create.mockRejectedValue(error)
    const response = await invoke('user:create', createIpcEvent().event, input)
    expect(response.code).toBe(code)
    expect(JSON.stringify(response)).not.toContain('private SQL parameters')
  })

  it('does not report success when committing the registration transaction fails', async () => {
    mocks.transaction.mockImplementation(
      async (operation: (transaction: Transaction) => Promise<unknown>) => {
        await operation(transaction)
        throw new Error('private transaction commit error')
      }
    )
    const response = await invoke('user:create', createIpcEvent().event, input)
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith(input, { transaction })
    expect(response).toMatchObject({ success: false, code: 'INTERNAL_ERROR' })
    expect(JSON.stringify(response)).not.toContain('private')
  })

  it('serializes the DTO inside the transaction so serialization failure aborts registration', async () => {
    mocks.create.mockResolvedValue({
      toJSON: () => {
        throw new Error('private serialization error')
      }
    })
    const response = await invoke('user:create', createIpcEvent().event, input)
    expect(response).toMatchObject({ success: false, code: 'INTERNAL_ERROR' })
    // The wrapped transaction rejects, confirming the insert did not commit.
    await expect(mocks.transaction.mock.results[0].value).rejects.toThrow(
      'private serialization error'
    )
  })

  it('rejects invalid registration before accessing the repository', async () => {
    expect(
      (await invoke('user:create', createIpcEvent().event, { ...input, password: 'short' })).code
    ).toBe('INVALID_INPUT')
    expect(mocks.findByEmail).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })
})

describe('user:login', () => {
  it('compares the password and establishes the main-process session', async () => {
    const comparePassword = vi.fn(async () => true)
    mocks.findUserForLogin.mockResolvedValue({
      id: dto.id,
      password: 'hash',
      comparePassword,
      toJSON: () => dto
    })
    const { event } = createIpcEvent()
    expect(await invoke('user:login', event, input)).toEqual({ success: true, data: dto })
    expect(mocks.findUserForLogin).toHaveBeenCalledExactlyOnceWith(input.email)
    expect(comparePassword).toHaveBeenCalledExactlyOnceWith(input.password)
    // A successful login records the user id in main-process memory keyed by sender.
    expect(requireSession(event)).toBe(dto.id)
  })

  it.each(['missing user', 'wrong password', 'lookup exception', 'comparison exception'])(
    'clears a previous session on %s',
    async (failure) => {
      const { event } = createIpcEvent()
      setSession(event, 99)
      if (failure === 'missing user') mocks.findUserForLogin.mockResolvedValue(null)
      else if (failure === 'lookup exception')
        mocks.findUserForLogin.mockRejectedValue(new Error('private SQL'))
      else
        mocks.findUserForLogin.mockResolvedValue({
          id: dto.id,
          comparePassword: async () => {
            if (failure === 'comparison exception') throw new Error('private password')
            return false
          }
        })
      const response = await invoke('user:login', event, input)
      expect(response.code).toBe(failure.endsWith('exception') ? 'INTERNAL_ERROR' : 'AUTH_FAILED')
      expect(() => requireSession(event)).toThrow(
        expect.objectContaining({ code: 'AUTH_REQUIRED' })
      )
      expect(JSON.stringify(response)).not.toContain('private')
    }
  )
})

describe('user:logout', () => {
  it('clears the session and returns null, including repeated logout', async () => {
    const { event } = createIpcEvent()
    setSession(event, dto.id)
    expect(await invoke('user:logout', event)).toEqual({ success: true, data: null })
    expect(await invoke('user:logout', event)).toEqual({ success: true, data: null })
    expect(() => requireSession(event)).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED' }))
  })

  it('rejects unexpected arguments', async () => {
    expect((await invoke('user:logout', createIpcEvent().event, { userId: 99 })).code).toBe(
      'INVALID_INPUT'
    )
  })
})

it.each([
  'user:create',
  'user:login',
  'user:session',
  'user:logout',
  'user:remembered-account',
  'user:login-remembered',
  'user:forget-remembered-account'
])('rejects untrusted senders for %s', async (channel) => {
  expect((await invoke(channel, createIpcEvent(undefined, false).event, input)).code).toBe(
    'IPC_FORBIDDEN'
  )
  expect(mocks.findByEmail).not.toHaveBeenCalled()
  expect(mocks.findUserForLogin).not.toHaveBeenCalled()
  expect(mocks.findForSession).not.toHaveBeenCalled()
  expect(mocks.create).not.toHaveBeenCalled()
})

describe('user:session', () => {
  it('does not infer authentication from an account existing in the database', async () => {
    expect(await invoke('user:session', createIpcEvent().event)).toMatchObject({
      code: 'AUTH_REQUIRED'
    })
    expect(mocks.findForSession).not.toHaveBeenCalled()
  })

  it('returns only public identity without reinstalling the session or clearing keys', async () => {
    const { event } = createIpcEvent()
    setSession(event, dto.id)
    unlockNotebook(event, 7, Buffer.alloc(32, 7))
    mocks.findForSession.mockResolvedValue({
      id: dto.id,
      toJSON: () => ({
        ...dto,
        createdAt: new Date(dto.createdAt),
        password: 'internal-secret',
        deletedAt: null
      })
    })
    expect(await invoke('user:session', event)).toEqual({ success: true, data: dto })
    expect(mocks.findForSession).toHaveBeenCalledExactlyOnceWith(dto.id)
    expect(requireSession(event)).toBe(dto.id)
    const key = requireUnlockedNotebook(event, 7)
    expect(key).toEqual(Buffer.alloc(32, 7))
    key.fill(0)
  })

  it('rejects a renderer supplied userId before querying the account', async () => {
    const { event } = createIpcEvent()
    setSession(event, dto.id)
    expect(await invoke('user:session', event, { userId: 99 })).toMatchObject({
      code: 'INVALID_INPUT'
    })
    expect(mocks.findForSession).not.toHaveBeenCalled()
  })

  it('clears a stale session if the current account no longer exists', async () => {
    const { event } = createIpcEvent()
    setSession(event, dto.id)
    mocks.findForSession.mockResolvedValue(null)
    expect(await invoke('user:session', event)).toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(() => requireSession(event)).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED' }))
  })

  it.each(['logout', 'same-account-relogin'])(
    'does not apply a lookup belonging to an old %s epoch',
    async (mode) => {
      const { event } = createIpcEvent()
      setSession(event, dto.id)
      const gate: { resolve?: (value: unknown) => void } = {}
      const pendingLookup = new Promise((resolve) => {
        gate.resolve = resolve
      })
      mocks.findForSession.mockReturnValue(pendingLookup)
      const response = invoke('user:session', event)
      await vi.waitFor(() => expect(mocks.findForSession).toHaveBeenCalledTimes(1))
      if (mode === 'logout') clearSession(event)
      else setSession(event, dto.id)
      gate.resolve?.({ id: dto.id, toJSON: () => dto })
      expect(await response).toMatchObject({ success: false, code: 'OPERATION_CANCELLED' })
      if (mode === 'same-account-relogin') expect(requireSession(event)).toBe(dto.id)
      else expect(() => requireSession(event)).toThrow()
    }
  )
})
