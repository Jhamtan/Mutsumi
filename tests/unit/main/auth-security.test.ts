import { EventEmitter } from 'node:events'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type { IpcResponse } from '../../../src/common/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 独立合成数据测试：不导入任何既有认证测试或真实数据库。
const mocks = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (
      event: IpcMainInvokeEvent,
      data?: unknown
    ) => IpcResponse<unknown> | Promise<IpcResponse<unknown>>
  >(),
  repository: {
    findUserForLogin: vi.fn(),
    findByEmail: vi.fn(),
    create: vi.fn(),
    transaction: vi.fn()
  },
  hash: vi.fn(),
  compare: vi.fn(),
  logError: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (
        event: IpcMainInvokeEvent,
        data?: unknown
      ) => IpcResponse<unknown> | Promise<IpcResponse<unknown>>
    ) => {
      mocks.handlers.set(channel, handler)
    }
  }
}))
vi.mock('../../../src/main/database/repositories/UserRepository', () => ({
  default: class {
    findUserForLogin = mocks.repository.findUserForLogin
    findByEmail = mocks.repository.findByEmail
    create = mocks.repository.create
    transaction = mocks.repository.transaction
  }
}))
vi.mock('bcryptjs', () => ({ hash: mocks.hash, compare: mocks.compare }))
vi.mock('../../../src/main/logger', () => ({ default: { error: mocks.logError } }))

const RENDERER_URL = 'file:///synthetic/renderer/index.html'
const credentials = { email: 'synthetic@example.test', password: 'SyntheticPassword42' }
const publicUser = { id: 71, name: 'Synthetic User', email: credentials.email }

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function createEvent() {
  const sender = Object.assign(new EventEmitter(), {
    id: 100,
    mainFrame: { url: RENDERER_URL },
    isDestroyed: () => false
  })
  return {
    sender,
    event: { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent
  }
}

function syntheticUser(comparePassword = vi.fn().mockResolvedValue(true)) {
  return { id: publicUser.id, comparePassword, toJSON: () => ({ ...publicUser }) }
}

let security: typeof import('../../../src/main/ipc/security')
let sender: ReturnType<typeof createEvent>['sender']
let event: IpcMainInvokeEvent

async function invoke(channel: string, data?: unknown) {
  return mocks.handlers.get(channel)!(event, data)
}

beforeEach(async () => {
  vi.resetModules()
  mocks.handlers.clear()
  for (const mock of Object.values(mocks.repository)) mock.mockReset()
  mocks.hash.mockReset().mockResolvedValue('synthetic-dummy-hash-cost-10')
  mocks.compare.mockReset().mockResolvedValue(false)
  mocks.logError.mockReset()
  mocks.repository.findUserForLogin.mockResolvedValue(null)
  mocks.repository.findByEmail.mockResolvedValue(null)
  mocks.repository.transaction.mockImplementation((callback) => callback({ synthetic: true }))
  mocks.repository.create.mockResolvedValue({ toJSON: () => ({ ...publicUser }) })
  security = await import('../../../src/main/ipc/security')
  const fixture = createEvent()
  sender = fixture.sender
  event = fixture.event
  security.trustIpcSender(sender as unknown as WebContents, RENDERER_URL)
  const { registerAuthHandlers } = await import('../../../src/main/ipc/handlers/auth-handlers')
  registerAuthHandlers()
})

describe('认证安全边界（合成数据）', () => {
  it('成功登录在 SQL 与 bcrypt 后建立会话，响应不带密码', async () => {
    const user = syntheticUser()
    mocks.repository.findUserForLogin.mockResolvedValue(user)
    expect(await invoke('user:login', credentials)).toEqual({ success: true, data: publicUser })
    expect(user.comparePassword).toHaveBeenCalledWith(credentials.password)
    expect(security.requireSession(event)).toBe(publicUser.id)
  })

  it('未知账号也进行相同成本比较，响应与错误密码一致', async () => {
    const unknownResponse = await invoke('user:login', credentials)
    expect(mocks.hash).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{64}$/), 10)
    expect(mocks.compare).toHaveBeenCalledWith(credentials.password, 'synthetic-dummy-hash-cost-10')
    mocks.repository.findUserForLogin.mockResolvedValue(
      syntheticUser(vi.fn().mockResolvedValue(false))
    )
    expect(await invoke('user:login', credentials)).toEqual(unknownResponse)
    expect(unknownResponse).toMatchObject({ success: false, code: 'AUTH_FAILED' })
    expect(() => security.requireSession(event)).toThrow()
  })

  it('dummy hash 每次模块初始化来自随机秘密，比较结果不能登录未知账号', async () => {
    const firstSecret = mocks.hash.mock.calls[0][0]
    vi.resetModules()
    await import('../../../src/main/ipc/handlers/auth-handlers')
    expect(mocks.hash.mock.calls[1][0]).not.toBe(firstSecret)
    mocks.compare.mockResolvedValue(true)
    expect(await invoke('user:login', credentials)).toMatchObject({
      success: false,
      code: 'AUTH_FAILED'
    })
  })

  it('等待 SQL 时导航后迟到登录不能建立会话', async () => {
    const started = deferred()
    const lookup = deferred<ReturnType<typeof syntheticUser>>()
    mocks.repository.findUserForLogin.mockImplementation(() => {
      started.resolve()
      return lookup.promise
    })
    const result = invoke('user:login', credentials)
    await started.promise
    sender.emit('did-start-navigation', {}, RENDERER_URL, false, true)
    lookup.resolve(syntheticUser())
    expect(await result).toMatchObject({ success: false })
    expect(() => security.requireSession(event)).toThrow()
  })

  it('等待 bcrypt 时清理会话使迟到登录失效', async () => {
    const started = deferred()
    const comparison = deferred<boolean>()
    mocks.repository.findUserForLogin.mockResolvedValue(
      syntheticUser(
        vi.fn(() => {
          started.resolve()
          return comparison.promise
        })
      )
    )
    const result = invoke('user:login', credentials)
    await started.promise
    security.clearSession(event)
    comparison.resolve(true)
    expect(await result).toMatchObject({ success: false })
    expect(() => security.requireSession(event)).toThrow()
  })

  it('旧认证结果不能覆盖新的认证版本', async () => {
    const started = deferred()
    const comparison = deferred<boolean>()
    mocks.repository.findUserForLogin.mockResolvedValue(
      syntheticUser(
        vi.fn(() => {
          started.resolve()
          return comparison.promise
        })
      )
    )
    const result = invoke('user:login', credentials)
    await started.promise
    const guard = security.beginAuthentication(event)
    security.setSession(event, 72, guard)
    comparison.resolve(true)
    expect(await result).toMatchObject({ success: false })
    expect(security.requireSession(event)).toBe(72)
  })

  it('登出不等待登录队列，并使迟到的密码比较结果失效', async () => {
    const started = deferred()
    const comparison = deferred<boolean>()
    mocks.repository.findUserForLogin.mockResolvedValue(
      syntheticUser(
        vi.fn(() => {
          started.resolve()
          return comparison.promise
        })
      )
    )
    const login = invoke('user:login', credentials)
    await started.promise
    const logout = invoke('user:logout')
    try {
      expect(await logout).toEqual({ success: true, data: null })
      expect(() => security.requireSession(event)).toThrow(
        expect.objectContaining({ code: 'AUTH_REQUIRED' })
      )
    } finally {
      comparison.resolve(true)
    }
    expect(await login).toMatchObject({ success: false, code: 'OPERATION_CANCELLED' })
    expect(() => security.requireSession(event)).toThrow()
    expect(await invoke('user:logout')).toEqual({ success: true, data: null })
  })

  it('每个窗口登录每分钟最多八次，并在分钟边界后恢复', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0)
    for (let attempt = 0; attempt < 8; attempt++) {
      expect(await invoke('user:login', credentials)).toMatchObject({ code: 'AUTH_FAILED' })
    }
    const blocked = await invoke('user:login', credentials)
    expect(blocked).toMatchObject({ success: false, code: 'RATE_LIMITED' })
    expect(mocks.repository.findUserForLogin).toHaveBeenCalledTimes(8)
    expect(mocks.compare).toHaveBeenCalledTimes(8)
    now.mockReturnValue(59_999)
    expect(await invoke('user:login', credentials)).toMatchObject({ code: 'RATE_LIMITED' })
    expect(mocks.repository.findUserForLogin).toHaveBeenCalledTimes(8)
    now.mockReturnValue(60_000)
    expect(await invoke('user:login', credentials)).toMatchObject({ code: 'AUTH_FAILED' })
    expect(mocks.repository.findUserForLogin).toHaveBeenCalledTimes(9)
  })

  it('登录配额绑定窗口，不共享到另一可信窗口', async () => {
    for (let attempt = 0; attempt < 8; attempt++) await invoke('user:login', credentials)
    expect(await invoke('user:login', credentials)).toMatchObject({ success: false })
    const other = createEvent()
    other.sender.id = 101
    security.trustIpcSender(other.sender as unknown as WebContents, RENDERER_URL)
    expect(await mocks.handlers.get('user:login')!(other.event, credentials)).toMatchObject({
      code: 'AUTH_FAILED'
    })
    expect(mocks.repository.findUserForLogin).toHaveBeenCalledTimes(9)
  })

  it('每个窗口注册每分钟最多四次，且登录与注册使用独立桶', async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      expect(await invoke('user:create', { ...credentials, name: 'Synthetic User' })).toMatchObject(
        { success: true }
      )
    }
    expect(await invoke('user:create', { ...credentials, name: 'Synthetic User' })).toMatchObject({
      success: false
    })
    expect(mocks.repository.create).toHaveBeenCalledTimes(4)
    expect(await invoke('user:login', credentials)).toMatchObject({ code: 'AUTH_FAILED' })
  })

  it('超过 16 KiB 的登录载荷在查询和 bcrypt 前拒绝', async () => {
    const response = await invoke('user:login', { ...credentials, padding: 'x'.repeat(16 * 1024) })
    expect(response.success).toBe(false)
    expect(mocks.repository.findUserForLogin).not.toHaveBeenCalled()
    expect(mocks.compare).not.toHaveBeenCalled()
  })

  it('原始秘密错误不进入响应或日志', async () => {
    const secret = 'SyntheticSecretNotForLogging'
    mocks.repository.findUserForLogin.mockRejectedValue(new Error(secret))
    const response = await invoke('user:login', credentials)
    expect(response).toMatchObject({ success: false, code: 'INTERNAL_ERROR' })
    expect(JSON.stringify(response)).not.toContain(secret)
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain(secret)
  })
})
