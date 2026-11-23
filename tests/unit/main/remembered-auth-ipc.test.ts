import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResponse, UserDTO, RememberedAccountInfoDTO } from '../../../src/common/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createIpcEvent } from '../helpers/ipc-event'
import { AppError } from '../../../src/main/errors'
import { requireSession, setSession } from '../../../src/main/ipc/security'
import { registerAuthHandlers } from '../../../src/main/ipc/handlers/auth-handlers'

type Handler = (
  event: IpcMainInvokeEvent,
  data?: unknown
) => IpcResponse<unknown> | Promise<IpcResponse<unknown>>
type SavedUse = (
  email: string,
  guard: (() => void) | undefined,
  operation: (email: string, password: string) => Promise<unknown>
) => Promise<unknown>
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  findUser: vi.fn(),
  comparePassword: vi.fn(),
  hash: vi.fn().mockResolvedValue('synthetic-dummy-hash'),
  compare: vi.fn(),
  info: vi.fn<() => Promise<RememberedAccountInfoDTO>>(),
  remember: vi.fn<(email: string, password: string, guard?: () => void) => Promise<void>>(),
  clear: vi.fn<(guard?: () => void) => Promise<void>>(),
  useSaved: vi.fn<SavedUse>()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler) }
}))
vi.mock('bcryptjs', () => ({ hash: mocks.hash, compare: mocks.compare }))
vi.mock('../../../src/main/logger', () => ({ default: { error: vi.fn() } }))
vi.mock('../../../src/main/database/repositories/UserRepository', () => ({
  default: class {
    findUserForLogin = mocks.findUser
  }
}))
vi.mock('../../../src/main/services/RememberedAccountService', () => ({
  default: class {
    getInfo = mocks.info
    remember = mocks.remember
    clear = mocks.clear
    useRemembered = mocks.useSaved
  }
}))

const email = 'remembered@example.test'
const password = 'SyntheticSavedPassword42'
const user: UserDTO = {
  id: 71,
  name: 'Synthetic',
  email,
  createdAt: '2026-11-21T00:00:00.000Z',
  updatedAt: '2026-11-21T00:00:00.000Z'
}
const info: RememberedAccountInfoDTO = {
  email,
  hasSavedPassword: true,
  encryptionAvailable: true,
  recordStatus: 'saved'
}
function record() {
  return {
    id: user.id,
    comparePassword: mocks.comparePassword,
    toJSON: () => ({
      ...user,
      password,
      internalToken: 'private-token',
      createdAt: new Date(user.createdAt)
    })
  }
}
function invoke(channel: string, event: IpcMainInvokeEvent, data?: unknown) {
  return mocks.handlers.get(channel)!(event, data)
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Gate not initialized')
  }
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

beforeEach(() => {
  mocks.handlers.clear()
  vi.clearAllMocks()
  mocks.findUser.mockReset().mockResolvedValue(record())
  mocks.comparePassword.mockReset().mockResolvedValue(true)
  mocks.compare.mockReset().mockResolvedValue(false)
  mocks.info.mockReset().mockResolvedValue(info)
  mocks.remember.mockReset().mockResolvedValue(undefined)
  mocks.clear.mockReset().mockResolvedValue(undefined)
  mocks.useSaved.mockReset().mockImplementation(async (selected, guard, operation) => {
    guard?.()
    if (selected !== email)
      throw new AppError('Saved account missing', 'REMEMBERED_ACCOUNT_MISSING')
    const result = await operation(email, password)
    guard?.()
    return result
  })
  registerAuthHandlers()
})

describe('remembered credentials IPC', () => {
  it('remembered metadata alone never establishes authentication or returns a password', async () => {
    const { event } = createIpcEvent()
    expect(await invoke('user:remembered-account', event)).toEqual({ success: true, data: info })
    expect(() => requireSession(event)).toThrow()
    expect(mocks.comparePassword).not.toHaveBeenCalled()
    expect(JSON.stringify(await invoke('user:remembered-account', event))).not.toContain(password)
  })

  it('stores credentials only after actual password verification', async () => {
    const { event } = createIpcEvent()
    const response = await invoke('user:login', event, { email, password, rememberAccount: true })
    expect(mocks.comparePassword).toHaveBeenCalledWith(password)
    expect(mocks.remember).toHaveBeenCalledWith(email, password, expect.any(Function))
    expect(response).toEqual({
      success: true,
      data: { ...user, rememberedAccount: { saved: true } }
    })
    expect(JSON.stringify(response)).not.toContain(password)
    expect(JSON.stringify(response)).not.toContain('private-token')
    expect(requireSession(event)).toBe(user.id)
  })

  it('wrong passwords are not remembered and do not restore an older session', async () => {
    const { event } = createIpcEvent()
    setSession(event, user.id)
    mocks.comparePassword.mockResolvedValue(false)
    expect(
      await invoke('user:login', event, { email, password, rememberAccount: true })
    ).toMatchObject({ code: 'AUTH_FAILED' })
    expect(mocks.remember).not.toHaveBeenCalled()
    expect(() => requireSession(event)).toThrow()
  })

  it('storage failure does not turn an otherwise verified login into failed authentication', async () => {
    const { event } = createIpcEvent()
    mocks.remember.mockRejectedValue(
      new AppError('Private OS details', 'REMEMBERED_ACCOUNT_UNAVAILABLE')
    )
    expect(await invoke('user:login', event, { email, password, rememberAccount: true })).toEqual({
      success: true,
      data: { ...user, rememberedAccount: { saved: false, error: 'unavailable' } }
    })
    expect(requireSession(event)).toBe(user.id)
  })

  it('saved login verifies inside the guarded callback and establishes its session afterwards', async () => {
    const { event } = createIpcEvent()
    const response = await invoke('user:login-remembered', event, { email, rememberAccount: true })
    expect(response).toEqual({
      success: true,
      data: { ...user, rememberedAccount: { saved: true } }
    })
    expect(mocks.comparePassword).toHaveBeenCalledExactlyOnceWith(password)
    expect(requireSession(event)).toBe(user.id)
    expect(JSON.stringify(response)).not.toContain(password)
  })

  it.each(['missing-account', 'changed-password'])(
    'saved credentials cannot authenticate a %s',
    async (mode) => {
      const { event } = createIpcEvent()
      if (mode === 'missing-account') mocks.findUser.mockResolvedValue(null)
      else mocks.comparePassword.mockResolvedValue(false)
      expect(await invoke('user:login-remembered', event, { email })).toMatchObject({
        success: false,
        code: 'AUTH_FAILED'
      })
      expect(mocks.remember).not.toHaveBeenCalled()
      expect(() => requireSession(event)).toThrow()
    }
  )

  it('normal and saved login share the same eight-attempt window budget', async () => {
    const { event } = createIpcEvent()
    for (let index = 0; index < 8; index++)
      expect((await invoke('user:login-remembered', event, { email })).success).toBe(true)
    expect(await invoke('user:login', event, { email, password })).toMatchObject({
      code: 'RATE_LIMITED'
    })
    expect(mocks.findUser).toHaveBeenCalledTimes(8)
  })

  it('logout while system decryption is pending cancels the old saved login before lookup', async () => {
    const { event } = createIpcEvent()
    const entered = deferred<void>()
    const release = deferred<void>()
    mocks.useSaved.mockImplementation(async (_email, guard, operation) => {
      entered.resolve()
      await release.promise
      guard?.()
      return operation(email, password)
    })
    const pending = invoke('user:login-remembered', event, { email })
    await entered.promise
    await invoke('user:logout', event)
    release.resolve()
    expect(await pending).toMatchObject({ code: 'OPERATION_CANCELLED' })
    expect(mocks.findUser).not.toHaveBeenCalled()
    expect(() => requireSession(event)).toThrow()
  })

  it('logout during a pending remember write cannot be undone by the old successful password check', async () => {
    const { event } = createIpcEvent()
    const entered = deferred<void>()
    const release = deferred<void>()
    mocks.remember.mockImplementation(async (_email, _password, guard) => {
      entered.resolve()
      await release.promise
      guard?.()
    })
    const pending = invoke('user:login', event, { email, password, rememberAccount: true })
    await entered.promise
    await invoke('user:logout', event)
    release.resolve()
    expect(await pending).toMatchObject({ code: 'OPERATION_CANCELLED' })
    expect(() => requireSession(event)).toThrow()
  })

  it('forgetting preferences clears only storage and does not log out a live account', async () => {
    const { event } = createIpcEvent()
    setSession(event, user.id)
    expect(await invoke('user:forget-remembered-account', event)).toEqual({
      success: true,
      data: null
    })
    expect(mocks.clear).toHaveBeenCalledWith(expect.any(Function))
    expect(requireSession(event)).toBe(user.id)
  })

  it.each(['user:remembered-account', 'user:login-remembered', 'user:forget-remembered-account'])(
    'rejects untrusted senders for %s before touching saved data',
    async (channel) => {
      expect(
        await invoke(channel, createIpcEvent(undefined, false).event, { email })
      ).toMatchObject({ code: 'IPC_FORBIDDEN' })
      expect(mocks.info).not.toHaveBeenCalled()
      expect(mocks.useSaved).not.toHaveBeenCalled()
      expect(mocks.clear).not.toHaveBeenCalled()
    }
  )

  it('saved login does not accept a raw password or arbitrary storage path', async () => {
    expect(
      await invoke('user:login-remembered', createIpcEvent().event, {
        email,
        password,
        path: '/other'
      })
    ).toMatchObject({ code: 'INVALID_INPUT' })
    expect(mocks.useSaved).not.toHaveBeenCalled()
  })
})
