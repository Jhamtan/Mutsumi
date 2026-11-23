import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import type { IpcResponse, NotebookSummaryDTO, UserDTO } from '../../../src/common/types'
import { useUserStore } from '../../../src/renderer/src/store/user'
import { useNotebookStore } from '../../../src/renderer/src/store/notebook'
import { attachAuthenticationGuard } from '../../../src/renderer/src/config/router'
import {
  getSafeLoginRedirect,
  useSessionOperation,
  type SessionOperation
} from '../../../src/renderer/src/composables/useSessionOperation'
import WorkspaceLayout from '../../../src/renderer/src/views/WorkspaceLayout.vue'

const user: UserDTO = {
  id: 31,
  name: '合成会话用户',
  email: 'session@example.test',
  createdAt: '2026-11-21T00:00:00.000Z',
  updatedAt: '2026-11-21T00:00:00.000Z'
}
const notebook: NotebookSummaryDTO = {
  id: 7,
  uuid: '77777777-7777-4777-8777-777777777777',
  name: '内存日记本',
  createdAt: user.createdAt,
  updatedAt: user.updatedAt
}
const getCurrentUser = vi.fn<IAppApi['getCurrentUser']>()
const logout = vi.fn<IAppApi['logout']>()
const request = vi.fn<() => Promise<IpcResponse<string>>>()
const wrappers = new Set<{ unmount(): void }>()
const EmptyPage = defineComponent({
  setup() {
    return () => h('div')
  }
})
const fakeRoutes: RouteRecordRaw[] = [
  ...['/home', '/notebooks', '/settings', '/diaries/:id'].map((path) => ({
    path,
    component: EmptyPage,
    meta: { requiresAuth: true }
  })),
  ...['/login', '/register'].map((path) => ({
    path,
    component: EmptyPage,
    meta: { guestOnly: true }
  })),
  { path: '/public', component: EmptyPage },
  { path: '/:pathMatch(.*)*', component: EmptyPage }
]
const transientCodes = [
  'OPERATION_CANCELLED',
  'RATE_LIMITED',
  'SESSION_BUSY',
  'INTERNAL_ERROR'
] as const
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function memoryStorage() {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: vi.fn<Storage['clear']>(() => {
      values.clear()
    }),
    getItem: vi.fn<Storage['getItem']>((key) => values.get(key) ?? null),
    key: vi.fn<Storage['key']>((index) => [...values.keys()][index] ?? null),
    removeItem: vi.fn<Storage['removeItem']>((key) => {
      values.delete(key)
    }),
    setItem: vi.fn<Storage['setItem']>((key, value) => {
      values.set(key, value)
    })
  } satisfies Storage
}
let storage: ReturnType<typeof memoryStorage>
function createSession(withUser = true) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const session = useUserStore(pinia)
  const notebooks = useNotebookStore(pinia)
  if (withUser) session.setUser({ ...user })
  return { pinia, session, notebooks }
}
function seedNotebooks(notebooks: ReturnType<typeof useNotebookStore>) {
  notebooks.setCurrent({ ...notebook })
  notebooks.markUnlocked(8)
}
function expectMirrors(notebooks: ReturnType<typeof useNotebookStore>) {
  expect(notebooks.current).toEqual(notebook)
  expect(notebooks.unlockedIds).toEqual([7, 8])
}
function authenticate(session: ReturnType<typeof useUserStore>, newUser: UserDTO) {
  const attempt = session.beginAuthentication()
  expect(session.completeAuthentication(newUser, attempt)).toBe(true)
}

beforeEach(() => {
  storage = memoryStorage()
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('sessionStorage', memoryStorage())
  getCurrentUser.mockReset().mockResolvedValue({ success: true, data: { ...user } })
  logout.mockReset().mockResolvedValue({ success: true, data: null })
  request.mockReset().mockResolvedValue({ success: true, data: '当前操作结果' })
  vi.stubGlobal('api', { getCurrentUser, logout } satisfies Pick<
    IAppApi,
    'getCurrentUser' | 'logout'
  >)
})
afterEach(() => {
  wrappers.forEach((wrapper) => wrapper.unmount())
  wrappers.clear()
  vi.unstubAllGlobals()
})

describe('主进程会话恢复与导航守卫', () => {
  it('主进程成功恢复丢失的前端身份，不读取 auth:user 伪造缓存', async () => {
    storage.setItem('auth:user', JSON.stringify({ ...user, id: 999 }))
    storage.setItem('unrelated', '保留')
    const { pinia, session } = createSession(false)
    expect(session.isLoggedIn).toBe(false)
    const router = createRouter({ history: createMemoryHistory(), routes: fakeRoutes })
    attachAuthenticationGuard(router, pinia)
    await router.push('/notebooks')
    await router.isReady()
    expect(getCurrentUser).toHaveBeenCalledExactlyOnceWith()
    expect(session.currentUser).toEqual(user)
    expect(router.currentRoute.value.path).toBe('/notebooks')
    expect(storage.getItem).not.toHaveBeenCalled()
    expect(storage.removeItem).toHaveBeenCalledWith('auth:user')
    storage.getItem.mockClear()
    expect(storage.getItem('unrelated')).toBe('保留')
  })

  it('多个保护路由普通导航持续确认主会话，保留同用户身份与解锁镜像', async () => {
    const { pinia, session, notebooks } = createSession()
    seedNotebooks(notebooks)
    const revision = session.sessionRevision
    const reset = vi.spyOn(notebooks, 'reset')
    const router = createRouter({ history: createMemoryHistory(), routes: fakeRoutes })
    attachAuthenticationGuard(router, pinia)
    for (const path of ['/home', '/notebooks', '/diaries/7', '/settings']) {
      await router.push(path)
      expect(router.currentRoute.value.path).toBe(path)
      expect(session.currentUser).toEqual(user)
      expect(session.sessionRevision).toBe(revision)
      expectMirrors(notebooks)
    }
    expect(getCurrentUser).toHaveBeenCalledTimes(4)
    expect(reset).not.toHaveBeenCalled()
    expect(logout).not.toHaveBeenCalled()
  })

  it('同用户 lookup 可更新资料但不重置日记本解锁镜像或会话代际', async () => {
    const { session, notebooks } = createSession()
    seedNotebooks(notebooks)
    const snapshot = session.captureSession()
    getCurrentUser.mockResolvedValue({ success: true, data: { ...user, name: '更新资料' } })
    expect(await session.synchronizeFromMain()).toBe('authenticated')
    expect(session.currentUser?.name).toBe('更新资料')
    expect(session.captureSession()).toEqual(snapshot)
    expect(session.matchesSession(snapshot)).toBe(true)
    expectMirrors(notebooks)
  })

  it('主会话切换为不同用户时刷新身份并清除旧账号日记本镜像', async () => {
    const { session, notebooks } = createSession()
    seedNotebooks(notebooks)
    const revision = session.sessionRevision
    getCurrentUser.mockResolvedValue({ success: true, data: { ...user, id: 32 } })
    expect(await session.synchronizeFromMain()).toBe('authenticated')
    expect(session.currentUser?.id).toBe(32)
    expect(session.sessionRevision).toBeGreaterThan(revision)
    expect(notebooks.current).toBeNull()
    expect(notebooks.unlockedIds).toEqual([])
  })

  it('当前 AUTH_REQUIRED 清除身份及全部日记本镜像并带保护路径去登录', async () => {
    const { pinia, session, notebooks } = createSession()
    seedNotebooks(notebooks)
    const router = createRouter({ history: createMemoryHistory(), routes: fakeRoutes })
    await router.push('/public')
    attachAuthenticationGuard(router, pinia)
    getCurrentUser.mockResolvedValue({ success: false, code: 'AUTH_REQUIRED' })
    await router.push('/diaries/7?mode=edit')
    expect(session.isLoggedIn).toBe(false)
    expect(notebooks.current).toBeNull()
    expect(notebooks.unlockedIds).toEqual([])
    expect(router.currentRoute.value.path).toBe('/login')
    expect(router.currentRoute.value.query.redirect).toBe('/diaries/7?mode=edit')
  })

  it.each(transientCodes)('lookup 的 %s 不登出现有身份，也不清理日记本镜像', async (code) => {
    const { pinia, session, notebooks } = createSession()
    seedNotebooks(notebooks)
    const revision = session.sessionRevision
    getCurrentUser.mockResolvedValue({ success: false, code })
    expect(await session.synchronizeFromMain()).toBe('unavailable')
    const router = createRouter({ history: createMemoryHistory(), routes: fakeRoutes })
    attachAuthenticationGuard(router, pinia)
    await router.push('/settings')
    expect(router.currentRoute.value.path).toBe('/settings')
    expect(session.currentUser).toEqual(user)
    expect(session.sessionRevision).toBe(revision)
    expectMirrors(notebooks)
    expect(logout).not.toHaveBeenCalled()
  })

  it('lookup Promise 拒绝不推断已有会话失效', async () => {
    const { session, notebooks } = createSession()
    seedNotebooks(notebooks)
    getCurrentUser.mockRejectedValue(new Error('合成内部错误'))
    expect(await session.synchronizeFromMain()).toBe('unavailable')
    expect(session.currentUser).toEqual(user)
    expectMirrors(notebooks)
    expect(logout).not.toHaveBeenCalled()
  })

  it('未登录且主进程暂不可用时阻止从现有公共页进入保护路由', async () => {
    const { pinia, session } = createSession(false)
    const router = createRouter({ history: createMemoryHistory(), routes: fakeRoutes })
    await router.push('/public')
    attachAuthenticationGuard(router, pinia)
    getCurrentUser.mockResolvedValue({ success: false, code: 'SESSION_BUSY' })
    await router.push('/notebooks')
    expect(session.isLoggedIn).toBe(false)
    expect(router.currentRoute.value.path).toBe('/public')
  })

  it('匿名访问 guest 页也查询主会话，有有效身份则去主页', async () => {
    const { pinia, session } = createSession(false)
    const router = createRouter({ history: createMemoryHistory(), routes: fakeRoutes })
    attachAuthenticationGuard(router, pinia)
    await router.push('/login')
    expect(session.currentUser).toEqual(user)
    expect(router.currentRoute.value.path).toBe('/home')
    expect(getCurrentUser).toHaveBeenCalled()
  })
})

describe('会话代际、并发 lookup 与 logout', () => {
  it('同一代际同步 lookup 并发去重，完成后允许新的确认', async () => {
    const pending = deferred<IpcResponse<UserDTO>>()
    getCurrentUser.mockReturnValueOnce(pending.promise)
    const { session } = createSession()
    const first = session.synchronizeFromMain()
    const second = session.synchronizeFromMain()
    const third = session.synchronizeFromMain()
    expect(getCurrentUser).toHaveBeenCalledTimes(1)
    pending.resolve({ success: true, data: { ...user } })
    expect(await Promise.all([first, second, third])).toEqual([
      'authenticated',
      'authenticated',
      'authenticated'
    ])
    expect(await session.synchronizeFromMain()).toBe('authenticated')
    expect(getCurrentUser).toHaveBeenCalledTimes(2)
  })

  it.each(['不同账号', '同账号新代际'] as const)(
    '%s登录后旧 lookup 成功不得覆盖新身份',
    async (change) => {
      const pending = deferred<IpcResponse<UserDTO>>()
      getCurrentUser.mockReturnValue(pending.promise)
      const { session, notebooks } = createSession()
      const oldSnapshot = session.captureSession()
      const lookup = session.synchronizeFromMain()
      const newUser = { ...user, id: change === '不同账号' ? 32 : user.id, name: '新登录身份' }
      authenticate(session, newUser)
      seedNotebooks(notebooks)
      const newRevision = session.sessionRevision
      pending.resolve({ success: true, data: { ...user, name: '旧资料' } })
      expect(await lookup).toBe('stale')
      expect(session.currentUser).toEqual(newUser)
      expect(session.sessionRevision).toBe(newRevision)
      expect(session.matchesSession(oldSnapshot)).toBe(false)
      expectMirrors(notebooks)
    }
  )

  it.each(['不同账号', '同账号新代际'] as const)(
    '%s登录后旧 AUTH_REQUIRED 不得清除新身份或镜像',
    async (change) => {
      const pending = deferred<IpcResponse<UserDTO>>()
      getCurrentUser.mockReturnValue(pending.promise)
      const { session, notebooks } = createSession()
      const lookup = session.synchronizeFromMain()
      const newUser = { ...user, id: change === '不同账号' ? 32 : user.id, name: '新身份' }
      authenticate(session, newUser)
      seedNotebooks(notebooks)
      pending.resolve({ success: false, code: 'AUTH_REQUIRED' })
      expect(await lookup).toBe('stale')
      expect(session.currentUser).toEqual(newUser)
      expectMirrors(notebooks)
      expect(logout).not.toHaveBeenCalled()
    }
  )

  it('旧导航迟到 AUTH_REQUIRED 不能打断新登录导航', async () => {
    const { pinia, session, notebooks } = createSession()
    const router = createRouter({ history: createMemoryHistory(), routes: fakeRoutes })
    await router.push('/public')
    attachAuthenticationGuard(router, pinia)
    const pending = deferred<IpcResponse<UserDTO>>()
    getCurrentUser.mockReturnValueOnce(pending.promise)
    const navigation = router.push('/notebooks')
    await flushPromises()
    authenticate(session, { ...user, id: 32 })
    seedNotebooks(notebooks)
    getCurrentUser.mockResolvedValue({ success: true, data: { ...user, id: 32 } })
    await router.replace('/settings')
    pending.resolve({ success: false, code: 'AUTH_REQUIRED' })
    await navigation
    expect(router.currentRoute.value.path).toBe('/settings')
    expect(session.currentUser?.id).toBe(32)
    expectMirrors(notebooks)
  })

  it('新代际 lookup 独立启动，旧完成不能释放或覆盖新代际中的去重请求', async () => {
    const oldPending = deferred<IpcResponse<UserDTO>>()
    const newPending = deferred<IpcResponse<UserDTO>>()
    getCurrentUser.mockReturnValueOnce(oldPending.promise).mockReturnValueOnce(newPending.promise)
    const { session } = createSession()
    const oldLookup = session.synchronizeFromMain()
    authenticate(session, { ...user, id: 32 })
    const newLookup = session.synchronizeFromMain()
    oldPending.resolve({ success: true, data: { ...user } })
    expect(await oldLookup).toBe('stale')
    const duplicateNew = session.synchronizeFromMain()
    expect(getCurrentUser).toHaveBeenCalledTimes(2)
    newPending.resolve({ success: true, data: { ...user, id: 32 } })
    expect(await Promise.all([newLookup, duplicateNew])).toEqual(['authenticated', 'authenticated'])
    expect(session.currentUser?.id).toBe(32)
  })

  it('authenticationPending 时 synchronize 不请求或覆盖进行中的登录', async () => {
    const { session } = createSession()
    const attempt = session.beginAuthentication()
    expect(await session.synchronizeFromMain()).toBe('stale')
    expect(getCurrentUser).not.toHaveBeenCalled()
    expect(session.authenticationPending).toBe(true)
    expect(session.completeAuthentication({ ...user, id: 32 }, attempt)).toBe(true)
    expect(session.currentUser?.id).toBe(32)
  })

  it('先启动的 lookup 也不能在 authenticationPending 时赋值或结束登录', async () => {
    const pending = deferred<IpcResponse<UserDTO>>()
    getCurrentUser.mockReturnValue(pending.promise)
    const { session } = createSession()
    const lookup = session.synchronizeFromMain()
    const attempt = session.beginAuthentication()
    pending.resolve({ success: true, data: { ...user } })
    expect(await lookup).toBe('stale')
    expect(session.currentUser).toBeNull()
    expect(session.isCurrentAuthentication(attempt)).toBe(true)
    expect(session.completeAuthentication({ ...user, id: 32 }, attempt)).toBe(true)
  })

  it('begin/completeLogout single flight 仅发一次主进程退出并清除身份与镜像', async () => {
    const { session, notebooks } = createSession()
    seedNotebooks(notebooks)
    const pending = deferred<IpcResponse<null>>()
    logout.mockReturnValue(pending.promise)
    const complete = async () => {
      const attempt = session.beginLogout()
      if (attempt === undefined) return false
      const response = await logout()
      return response.success ? session.completeLogout(attempt) : session.failLogout(attempt)
    }
    const first = complete()
    const duplicate = complete()
    expect(logout).toHaveBeenCalledTimes(1)
    expect(await duplicate).toBe(false)
    expect(session.logoutPending).toBe(true)
    expect(await session.synchronizeFromMain()).toBe('stale')
    expect(getCurrentUser).not.toHaveBeenCalled()
    pending.resolve({ success: true, data: null })
    expect(await first).toBe(true)
    expect(session.isLoggedIn).toBe(false)
    expect(session.logoutPending).toBe(false)
    expect(notebooks.current).toBeNull()
    expect(notebooks.unlockedIds).toEqual([])
  })

  it.each(['不同账号', '同账号新代际'] as const)(
    '%s登录后旧 logout 完成不能擦除新身份或镜像',
    async (change) => {
      const { session, notebooks } = createSession()
      const attempt = session.beginLogout()
      expect(attempt).toBeTypeOf('number')
      if (attempt === undefined) throw new Error('测试预期创建退出代际')
      const newUser = { ...user, id: change === '不同账号' ? 32 : user.id, name: '新登录' }
      authenticate(session, newUser)
      seedNotebooks(notebooks)
      expect(session.completeLogout(attempt)).toBe(false)
      expect(session.failLogout(attempt)).toBe(false)
      expect(session.currentUser).toEqual(newUser)
      expectMirrors(notebooks)
      expect(session.logoutPending).toBe(false)
    }
  )

  it('当前 logout 失败保留身份与镜像，释放 single flight 并使旧快照失效', () => {
    const { session, notebooks } = createSession()
    seedNotebooks(notebooks)
    const snapshot = session.captureSession()
    const attempt = session.beginLogout()
    if (attempt === undefined) throw new Error('测试预期创建退出代际')
    expect(session.failLogout(attempt)).toBe(true)
    expect(session.currentUser).toEqual(user)
    expectMirrors(notebooks)
    expect(session.matchesSession(snapshot)).toBe(false)
    expect(session.beginLogout()).toBeTypeOf('number')
  })
})

async function mountOperationPage() {
  const fixture = createSession()
  seedNotebooks(fixture.notebooks)
  const router = createRouter({ history: createMemoryHistory(), routes: fakeRoutes })
  await router.push('/diaries/7?mode=edit')
  await router.isReady()
  let operations!: ReturnType<typeof useSessionOperation>
  const Harness = defineComponent({
    setup() {
      operations = useSessionOperation()
      const result = ref('尚无结果')
      const write = async () => {
        const response = await operations.capture().call(request, notebook.id)
        if (response?.success) result.value = response.data ?? '空结果'
      }
      return () =>
        h('section', [
          h('button', { 'data-testid': 'write', onClick: write }, '写入'),
          h('output', result.value)
        ])
    }
  })
  // 页面卸载时保留独立路由宿主，以便精确验证没有迟到导航。
  const host = mount(EmptyPage, { global: { plugins: [fixture.pinia, router] } })
  wrappers.add(host)
  const wrapper = mount(Harness, { global: { plugins: [fixture.pinia, router] } })
  wrappers.add(wrapper)
  return { ...fixture, router, wrapper, capture: () => operations.capture() }
}
type OperationPage = Awaited<ReturnType<typeof mountOperationPage>>
function unmountOperationPage(page: OperationPage) {
  wrappers.delete(page.wrapper)
  page.wrapper.unmount()
}

describe('useSessionOperation 页面和账号固定 owner', () => {
  it('当前页面回调成功才应用组件状态', async () => {
    const page = await mountOperationPage()
    await page.wrapper.get('[data-testid="write"]').trigger('click')
    await flushPromises()
    expect(request).toHaveBeenCalledExactlyOnceWith()
    expect(page.wrapper.get('output').text()).toBe('当前操作结果')
    expect(page.session.currentUser).toEqual(user)
    expectMirrors(page.notebooks)
  })

  it.each(['页面离开', '卸载', '不同账号', '同账号新代际'] as const)(
    '%s后迟到成功回调不应用旧组件状态',
    async (change) => {
      const pending = deferred<IpcResponse<string>>()
      request.mockReturnValue(pending.promise)
      const page = await mountOperationPage()
      await page.wrapper.get('[data-testid="write"]').trigger('click')
      if (change === '页面离开') await page.router.push('/settings')
      else if (change === '卸载') unmountOperationPage(page)
      else authenticate(page.session, { ...user, id: change === '不同账号' ? 32 : user.id })
      pending.resolve({ success: true, data: '旧页面不应应用' })
      await flushPromises()
      expect(page.wrapper.get('output').text()).toBe('尚无结果')
      expect(page.session.isLoggedIn).toBe(true)
      expect(logout).not.toHaveBeenCalled()
    }
  )

  it('页面离开后再返回原路径也不会复活已经捕获的操作', async () => {
    const page = await mountOperationPage()
    const operation = page.capture()
    await page.router.push('/settings')
    await page.router.push('/diaries/7?mode=edit')
    expect(operation.isActive()).toBe(false)
    expect(await operation.call(request)).toBeUndefined()
    expect(request).not.toHaveBeenCalled()
  })

  it.each(['不同账号', '同账号新代际'] as const)(
    '%s后旧账号页面即使重新 capture 也不能发起写入',
    async (change) => {
      const page = await mountOperationPage()
      authenticate(page.session, { ...user, id: change === '不同账号' ? 32 : user.id })
      seedNotebooks(page.notebooks)
      const freshCaptureOnOldPage = page.capture()
      expect(freshCaptureOnOldPage.isActive()).toBe(false)
      expect(await freshCaptureOnOldPage.call(request)).toBeUndefined()
      await page.wrapper.get('[data-testid="write"]').trigger('click')
      await flushPromises()
      expect(request).not.toHaveBeenCalled()
      expect(page.wrapper.get('output').text()).toBe('尚无结果')
      expectMirrors(page.notebooks)
    }
  )

  it('当前 AUTH_REQUIRED 清除身份及 notebook 镜像并导航登录', async () => {
    const page = await mountOperationPage()
    request.mockResolvedValue({ success: false, code: 'AUTH_REQUIRED' })
    expect(await page.capture().call(request)).toBeUndefined()
    expect(page.session.currentUser).toBeNull()
    expect(page.notebooks.current).toBeNull()
    expect(page.notebooks.unlockedIds).toEqual([])
    expect(page.router.currentRoute.value.path).toBe('/login')
    expect(page.router.currentRoute.value.query.redirect).toBe('/diaries/7?mode=edit')
    expect(logout).not.toHaveBeenCalled()
  })

  it.each(['页面离开', '卸载', '不同账号', '同账号新代际'] as const)(
    '%s后的旧 AUTH_REQUIRED 忽略且不导航或清除新会话',
    async (change) => {
      const page = await mountOperationPage()
      const pending = deferred<IpcResponse<string>>()
      const result = page.capture().call(() => pending.promise)
      if (change === '页面离开') await page.router.push('/settings')
      else if (change === '卸载') unmountOperationPage(page)
      else
        authenticate(page.session, {
          ...user,
          id: change === '不同账号' ? 32 : user.id,
          name: '新身份'
        })
      seedNotebooks(page.notebooks)
      const snapshot = page.session.captureSession()
      const path = page.router.currentRoute.value.fullPath
      pending.resolve({ success: false, code: 'AUTH_REQUIRED' })
      expect(await result).toBeUndefined()
      expect(page.session.captureSession()).toEqual(snapshot)
      expect(page.session.isLoggedIn).toBe(true)
      expect(page.router.currentRoute.value.fullPath).toBe(path)
      expectMirrors(page.notebooks)
    }
  )

  it('NOTEBOOK_LOCKED 仅清除目标镜像并去 notebooks，不登出或清除其他解锁项', async () => {
    const page = await mountOperationPage()
    const snapshot = page.session.captureSession()
    request.mockResolvedValue({ success: false, code: 'NOTEBOOK_LOCKED' })
    expect(await page.capture().call(request, notebook.id)).toBeUndefined()
    expect(page.notebooks.current).toBeNull()
    expect(page.notebooks.unlockedIds).toEqual([8])
    expect(page.session.currentUser).toEqual(user)
    expect(page.session.captureSession()).toEqual(snapshot)
    expect(page.router.currentRoute.value.path).toBe('/notebooks')
    expect(page.router.currentRoute.value.query.unlock).toBe('7')
    expect(logout).not.toHaveBeenCalled()
  })

  it('另一日记本 NOTEBOOK_LOCKED 保留当前日记本，只清对应解锁项', async () => {
    const page = await mountOperationPage()
    request.mockResolvedValue({ success: false, code: 'NOTEBOOK_LOCKED' })
    expect(await page.capture().call(request, 8)).toBeUndefined()
    expect(page.notebooks.current).toEqual(notebook)
    expect(page.notebooks.unlockedIds).toEqual([7])
    expect(page.session.isLoggedIn).toBe(true)
    expect(page.router.currentRoute.value.query.unlock).toBe('8')
  })

  it.each([undefined, 0, -1, 1.5])(
    'NOTEBOOK_LOCKED 缺少有效目标 %s 时不误清镜像或导航',
    async (notebookId) => {
      const page = await mountOperationPage()
      const response: IpcResponse<string> = { success: false, code: 'NOTEBOOK_LOCKED' }
      request.mockResolvedValue(response)
      expect(await page.capture().call(request, notebookId)).toEqual(response)
      expectMirrors(page.notebooks)
      expect(page.session.isLoggedIn).toBe(true)
      expect(page.router.currentRoute.value.path).toBe('/diaries/7')
    }
  )

  it.each(transientCodes)('页面操作 %s 直接返回业务结果，不退出或清日记本镜像', async (code) => {
    const page = await mountOperationPage()
    const response: IpcResponse<string> = { success: false, code, message: '合成业务失败' }
    request.mockResolvedValue(response)
    expect(await page.capture().call(request, notebook.id)).toEqual(response)
    expect(page.session.currentUser).toEqual(user)
    expectMirrors(page.notebooks)
    expect(page.router.currentRoute.value.path).toBe('/diaries/7')
    expect(request).toHaveBeenCalledTimes(1)
    expect(logout).not.toHaveBeenCalled()
  })

  it('旧页面请求迟到拒绝忽略，当前页面拒绝仍交给调用者处理', async () => {
    const page = await mountOperationPage()
    const pending = deferred<IpcResponse<string>>()
    const result = page.capture().call(() => pending.promise)
    await page.router.push('/settings')
    pending.reject(new Error('旧页面内部失败'))
    expect(await result).toBeUndefined()
    const error = new Error('当前页面内部失败')
    request.mockRejectedValue(error)
    await expect(page.capture().call(request)).rejects.toThrow(error)
    expect(page.session.isLoggedIn).toBe(true)
    expectMirrors(page.notebooks)
  })
})

describe('WorkspaceLayout 会话代际与路径重建页面', () => {
  it('按 sessionRevision 与完整路径重建固定 owner，不保留旧账号页面', async () => {
    const { pinia, session } = createSession()
    const operations: SessionOperation[] = []
    const Page = defineComponent({
      setup() {
        operations.push(useSessionOperation().capture())
        const instance = operations.length
        return () => h('output', `页面实例${instance}`)
      }
    })
    const TooltipStub = defineComponent({
      setup(_, { slots }) {
        return () => h('div', slots.default?.())
      }
    })
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: '/',
          component: WorkspaceLayout,
          meta: { requiresAuth: true },
          children: [
            { path: 'home', component: Page },
            { path: 'settings', component: Page },
            ...['notebooks', 'trips', 'photowall'].map((path) => ({ path, component: EmptyPage }))
          ]
        }
      ]
    })
    await router.push('/home?filter=first')
    await router.isReady()
    const wrapper = mount(RouterView, {
      global: { plugins: [pinia, router], stubs: { ElTooltip: TooltipStub } }
    })
    wrappers.add(wrapper)
    await flushPromises()
    expect(wrapper.get('output').text()).toBe('页面实例1')
    expect(operations[0].isActive()).toBe(true)
    await router.replace('/home?filter=second')
    await flushPromises()
    expect(wrapper.get('output').text()).toBe('页面实例2')
    expect(operations[0].isActive()).toBe(false)
    expect(operations[1].isActive()).toBe(true)
    authenticate(session, { ...user, name: '同账号新会话' })
    await flushPromises()
    expect(wrapper.get('output').text()).toBe('页面实例3')
    expect(operations[1].isActive()).toBe(false)
    expect(operations[2].isActive()).toBe(true)
    authenticate(session, { ...user, id: 32 })
    await flushPromises()
    expect(wrapper.get('output').text()).toBe('页面实例4')
    expect(operations[2].isActive()).toBe(false)
    expect(operations[3].isActive()).toBe(true)
    session.logout()
    await flushPromises()
    expect(wrapper.find('output').exists()).toBe(false)
    expect(operations[3].isActive()).toBe(false)
    expect(getCurrentUser).not.toHaveBeenCalled()
    expect(logout).not.toHaveBeenCalled()
  })
})

describe('getSafeLoginRedirect 只允许保护内链', () => {
  it.each(['/home', '/notebooks?unlock=7', '/diaries/7?mode=edit#content', '/settings'])(
    '接受已存在保护路由 %s',
    (redirect) => {
      const router = createRouter({ history: createMemoryHistory(), routes: fakeRoutes })
      expect(getSafeLoginRedirect(router, redirect)).toBe(redirect)
      expect(getCurrentUser).not.toHaveBeenCalled()
    }
  )

  it.each([
    'https://example.invalid/notebooks',
    '//example.invalid/notebooks',
    'notebooks',
    '/\\example.invalid/notebooks',
    '/notebooks\\..\\login',
    '/login',
    '/login?redirect=/home',
    '/register',
    '/public',
    '/unknown',
    '',
    null,
    undefined,
    ['/notebooks'],
    { path: '/notebooks' }
  ])('拒绝外链、双斜线、反斜线、guest 与未知路径 %j', (redirect) => {
    const router = createRouter({ history: createMemoryHistory(), routes: fakeRoutes })
    expect(getSafeLoginRedirect(router, redirect)).toBe('/home')
    expect(getCurrentUser).not.toHaveBeenCalled()
  })
})
