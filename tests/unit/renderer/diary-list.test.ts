import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import DiaryList from '../../../src/renderer/src/views/diary/DiaryList.vue'
import type { DiarySummaryDTO, IpcResponse, UserDTO } from '../../../src/common/types'
import type { DiaryPageDTO } from '../../../src/common/diary'
import { useNotebookStore } from '../../../src/renderer/src/store/notebook'
import { useUserStore } from '../../../src/renderer/src/store/user'
import { useI18nStore } from '../../../src/renderer/src/store/i18n'

/**
 * Tests the diary list view: card rendering with title/preview, empty state,
 * and navigation to the detail page on click.
 */
const ElSkeletonStub = { template: '<div class="el-skeleton-stub"></div>' }
const messages = { success: vi.fn(), error: vi.fn(), warning: vi.fn() }

const diaries: DiarySummaryDTO[] = [
  {
    id: 1,
    uuid: '11111111-1111-4111-8111-111111111111',
    notebookId: 7,
    occurredAt: '2026-11-07T09:00:00.000Z',
    createdAt: '2026-11-07T09:00:00.000Z',
    updatedAt: '2026-11-07T09:00:00.000Z',
    title: 'First entry',
    preview: 'A short preview text.'
  },
  {
    id: 2,
    uuid: '22222222-2222-4222-8222-222222222222',
    notebookId: 7,
    occurredAt: '2026-11-06T09:00:00.000Z',
    createdAt: '2026-11-06T09:00:00.000Z',
    updatedAt: '2026-11-06T09:00:00.000Z',
    preview: 'No title here.'
  }
]

const user: UserDTO = {
  id: 42,
  name: '分页合成用户',
  email: 'diary-page@example.test',
  createdAt: diaries[0].createdAt,
  updatedAt: diaries[0].updatedAt
}
const wrappers = new Set<{ unmount(): void }>()

function pageResult(
  items = diaries,
  total = items.length,
  page = 1,
  pageSize = 20
): IpcResponse<DiaryPageDTO> {
  return { success: true, data: { items, total, page, pageSize } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

let api: {
  listDiaryPage: ReturnType<typeof vi.fn<IAppApi['listDiaryPage']>>
  lockNotebook: ReturnType<typeof vi.fn<IAppApi['lockNotebook']>>
  exportDiaryBackup: ReturnType<typeof vi.fn<IAppApi['exportDiaryBackup']>>
}

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/notebooks', name: 'Notebooks', component: { template: '<div />' } },
      { path: '/login', name: 'Login', component: { template: '<div />' } },
      {
        path: '/notebooks/:notebookId/diaries',
        name: 'Diaries',
        component: { template: '<div />' }
      },
      {
        path: '/notebooks/:notebookId/diaries/:diaryId',
        name: 'DiaryDetail',
        component: { template: '<div />' }
      }
    ]
  })
}

async function mountList() {
  const router = makeRouter()
  await router.push('/notebooks/7/diaries')
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  useUserStore(pinia).setUser({ ...user })
  const wrapper = mount(DiaryList, {
    props: { notebookId: '7' },
    global: { plugins: [pinia, router], stubs: { ElSkeleton: ElSkeletonStub } }
  })
  wrappers.add(wrapper)
  await flushPromises()
  return { wrapper, router }
}

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value)
  })
  for (const message of Object.values(messages)) message.mockClear()
  vi.stubGlobal('ElMessage', messages)
  api = { listDiaryPage: vi.fn(), lockNotebook: vi.fn(), exportDiaryBackup: vi.fn() }
  ;(window as unknown as { api: unknown }).api = api
  api.listDiaryPage.mockResolvedValue(pageResult())
  api.lockNotebook.mockResolvedValue({ success: true, data: null })
  api.exportDiaryBackup.mockResolvedValue({
    success: true,
    data: { canceled: false, diaryCount: 45 }
  })
})

afterEach(() => {
  wrappers.forEach((wrapper) => wrapper.unmount())
  wrappers.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('DiaryList 日记备份', () => {
  it('页头导出整本及图片，仅传 notebookId，不传当前分页 IDs', async () => {
    api.listDiaryPage.mockResolvedValueOnce(pageResult([diaries[1]], 45, 2))
    const { wrapper, router } = await mountList()
    const store = useNotebookStore()
    store.markUnlocked(7)
    const reset = vi.spyOn(store, 'reset')
    await wrapper.get('[data-testid="export-backup"]').trigger('click')
    await flushPromises()
    expect(api.exportDiaryBackup).toHaveBeenCalledExactlyOnceWith({ notebookId: 7 })
    expect(api.listDiaryPage).toHaveBeenCalledTimes(1)
    expect(messages.success).toHaveBeenCalledWith(
      useI18nStore().t.backup.exportSuccess.replace('{count}', '45')
    )
    expect(wrapper.get('[data-testid="page-status"]').text()).toContain('2 / 3')
    expect(wrapper.findAll('[data-testid="diary-card"]')).toHaveLength(1)
    expect(store.isUnlocked(7)).toBe(true)
    expect(reset).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/notebooks/7/diaries')
    expect(wrapper.get('[data-testid="export-backup"]').attributes('disabled')).toBeUndefined()
  })

  it('空本也能导出并显示零篇成功提示', async () => {
    api.listDiaryPage.mockResolvedValueOnce(pageResult([]))
    api.exportDiaryBackup.mockResolvedValueOnce({
      success: true,
      data: { canceled: false, diaryCount: 0 }
    })
    const { wrapper } = await mountList()
    await wrapper.get('[data-testid="export-backup"]').trigger('click')
    await flushPromises()
    expect(api.exportDiaryBackup).toHaveBeenCalledExactlyOnceWith({ notebookId: 7 })
    expect(messages.success).toHaveBeenCalledWith(
      useI18nStore().t.backup.exportSuccess.replace('{count}', '0')
    )
  })

  it('取消原生保存静默处理且保留当前分页数据', async () => {
    api.exportDiaryBackup.mockResolvedValueOnce({ success: true, data: { canceled: true } })
    const { wrapper, router } = await mountList()
    await wrapper.get('[data-testid="export-backup"]').trigger('click')
    await flushPromises()
    expect(messages.success).not.toHaveBeenCalled()
    expect(messages.error).not.toHaveBeenCalled()
    expect(wrapper.findAll('[data-testid="diary-card"]')).toHaveLength(2)
    expect(router.currentRoute.value.path).toBe('/notebooks/7/diaries')
    expect(wrapper.get('[data-testid="export-backup"]').attributes('disabled')).toBeUndefined()
  })

  it.each(['response', 'exception', 'missing-data'])(
    '导出失败使用本地化通用提示且允许重试：%s',
    async (mode) => {
      if (mode === 'response')
        api.exportDiaryBackup.mockResolvedValueOnce({
          success: false,
          code: 'RATE_LIMITED',
          message: '不向界面泄露内部路径'
        })
      else if (mode === 'exception')
        api.exportDiaryBackup.mockRejectedValueOnce(new Error('合成传输异常'))
      else api.exportDiaryBackup.mockResolvedValueOnce({ success: true })
      const { wrapper } = await mountList()
      await wrapper.get('[data-testid="export-backup"]').trigger('click')
      await flushPromises()
      expect(messages.success).not.toHaveBeenCalled()
      expect(messages.error).toHaveBeenCalledExactlyOnceWith(useI18nStore().t.backup.exportFail)
      expect(wrapper.findAll('[data-testid="diary-card"]')).toHaveLength(2)
      expect(useUserStore().currentUser?.id).toBe(user.id)
      expect(wrapper.get('[data-testid="export-backup"]').attributes('disabled')).toBeUndefined()
    }
  )

  it('导出 pending 禁止重复导出和锁本，完成后恢复按钮', async () => {
    const pending = deferred<Awaited<ReturnType<IAppApi['exportDiaryBackup']>>>()
    api.exportDiaryBackup.mockReturnValueOnce(pending.promise)
    const { wrapper } = await mountList()
    await wrapper.get('[data-testid="export-backup"]').trigger('click')
    expect(wrapper.get('[data-testid="export-backup"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="export-backup"]').attributes('aria-busy')).toBe('true')
    expect(wrapper.get('[data-testid="lock-notebook"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="export-backup"]').trigger('click')
    await wrapper.get('[data-testid="lock-notebook"]').trigger('click')
    expect(api.exportDiaryBackup).toHaveBeenCalledTimes(1)
    expect(api.lockNotebook).not.toHaveBeenCalled()
    pending.resolve({ success: true, data: { canceled: true } })
    await flushPromises()
    expect(wrapper.get('[data-testid="lock-notebook"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-testid="export-backup"]').attributes('disabled')).toBeUndefined()
  })

  it('锁本 pending 不允许导出', async () => {
    const pending = deferred<Awaited<ReturnType<IAppApi['lockNotebook']>>>()
    api.lockNotebook.mockReturnValueOnce(pending.promise)
    const { wrapper } = await mountList()
    await wrapper.get('[data-testid="lock-notebook"]').trigger('click')
    expect(wrapper.get('[data-testid="export-backup"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="export-backup"]').trigger('click')
    expect(api.exportDiaryBackup).not.toHaveBeenCalled()
    pending.resolve({ success: false, code: 'INTERNAL_ERROR' })
    await flushPromises()
    expect(wrapper.get('[data-testid="export-backup"]').attributes('disabled')).toBeUndefined()
  })

  it.each(['AUTH_REQUIRED', 'NOTEBOOK_LOCKED'] as const)(
    '导出通过共享会话处理 %s，不叠加备份错误',
    async (code) => {
      api.exportDiaryBackup.mockResolvedValueOnce({ success: false, code })
      const { wrapper, router } = await mountList()
      const store = useNotebookStore()
      store.markUnlocked(7)
      store.markUnlocked(8)
      await wrapper.get('[data-testid="export-backup"]').trigger('click')
      await flushPromises()
      expect(messages.error).not.toHaveBeenCalled()
      expect(messages.success).not.toHaveBeenCalled()
      expect(store.isUnlocked(7)).toBe(false)
      if (code === 'AUTH_REQUIRED') {
        expect(useUserStore().currentUser).toBeNull()
        expect(router.currentRoute.value.path).toBe('/login')
        expect(router.currentRoute.value.query.redirect).toBe('/notebooks/7/diaries')
      } else {
        expect(useUserStore().currentUser?.id).toBe(user.id)
        expect(store.isUnlocked(8)).toBe(true)
        expect(router.currentRoute.value.path).toBe('/notebooks')
        expect(router.currentRoute.value.query.unlock).toBe('7')
      }
    }
  )

  describe.each(['account', 'same-session', 'route', 'unmount'] as const)(
    '导出 owner 失效：%s',
    (change) => {
      it.each(['success', 'AUTH_REQUIRED', 'NOTEBOOK_LOCKED', 'exception'] as const)(
        '忽略迟到 %s，不改新会话或弹出提示',
        async (result) => {
          const pending = deferred<Awaited<ReturnType<IAppApi['exportDiaryBackup']>>>()
          api.exportDiaryBackup.mockReturnValueOnce(pending.promise)
          const { wrapper, router } = await mountList()
          await wrapper.get('[data-testid="export-backup"]').trigger('click')
          if (change === 'account') useUserStore().setUser({ ...user, id: 99 })
          else if (change === 'same-session') useUserStore().setUser({ ...user })
          else if (change === 'route') await router.push('/notebooks')
          else {
            wrapper.unmount()
            wrappers.delete(wrapper)
          }
          const pathAfterChange = router.currentRoute.value.fullPath
          const store = useNotebookStore()
          store.markUnlocked(7)
          const reset = vi.spyOn(store, 'reset')
          const lock = vi.spyOn(store, 'lockNotebook')
          if (result === 'exception') pending.reject(new Error('迟到合成异常'))
          else
            pending.resolve(
              result === 'success'
                ? { success: true, data: { canceled: false, diaryCount: 900 } }
                : { success: false, code: result }
            )
          await flushPromises()
          expect(messages.success).not.toHaveBeenCalled()
          expect(messages.error).not.toHaveBeenCalled()
          expect(store.isUnlocked(7)).toBe(true)
          expect(reset).not.toHaveBeenCalled()
          expect(lock).not.toHaveBeenCalled()
          expect(useUserStore().currentUser?.id).toBe(change === 'account' ? 99 : user.id)
          expect(router.currentRoute.value.fullPath).toBe(pathAfterChange)
          if (change !== 'unmount') {
            expect(wrapper.get('[data-testid="export-backup"]').attributes('aria-busy')).toBe(
              'true'
            )
            expect(wrapper.findAll('[data-testid="diary-card"]')).toHaveLength(2)
          }
        }
      )
    }
  )
})

describe('DiaryList', () => {
  it('显示总数和页码，上一页下一页保持会话与日记本镜像', async () => {
    api.listDiaryPage.mockResolvedValueOnce(pageResult(diaries, 45))
    const { wrapper } = await mountList()
    const session = useUserStore()
    const revision = session.sessionRevision
    const notebookStore = useNotebookStore()
    notebookStore.markUnlocked(7)
    const reset = vi.spyOn(notebookStore, 'reset')
    expect(wrapper.get('[data-testid="diary-total"]').text()).toContain('45')
    expect(wrapper.get('[data-testid="page-status"]').text()).toContain('1 / 3')
    expect(wrapper.get('[data-testid="previous-page"]').attributes('disabled')).toBeDefined()
    api.listDiaryPage.mockResolvedValueOnce(pageResult([diaries[1]], 45, 2))
    await wrapper.get('[data-testid="next-page"]').trigger('click')
    await flushPromises()
    expect(api.listDiaryPage).toHaveBeenLastCalledWith(7, { page: 2, pageSize: 20 })
    expect(wrapper.get('[data-testid="page-status"]').text()).toContain('2 / 3')
    api.listDiaryPage.mockResolvedValueOnce(pageResult(diaries, 45, 1))
    await wrapper.get('[data-testid="previous-page"]').trigger('click')
    await flushPromises()
    expect(api.listDiaryPage).toHaveBeenLastCalledWith(7, { page: 1, pageSize: 20 })
    expect(session.sessionRevision).toBe(revision)
    expect(session.currentUser?.id).toBe(user.id)
    expect(notebookStore.isUnlocked(7)).toBe(true)
    expect(reset).not.toHaveBeenCalled()
  })

  it('自由应用1–100条并回到第一页，分页按钮不会提交表单', async () => {
    api.listDiaryPage.mockResolvedValueOnce(pageResult(diaries, 201, 3))
    const { wrapper } = await mountList()
    await wrapper.get('[data-testid="page-size"]').setValue('100')
    api.listDiaryPage.mockResolvedValueOnce(pageResult(diaries, 201, 1, 100))
    await wrapper.get('[data-testid="apply-page-size"]').trigger('click')
    await flushPromises()
    expect(api.listDiaryPage).toHaveBeenLastCalledWith(7, { page: 1, pageSize: 100 })
    expect(wrapper.get('[data-testid="page-status"]').text()).toContain('1 / 3')
    await wrapper.get('[data-testid="page-size"]').setValue('1')
    api.listDiaryPage.mockResolvedValueOnce(pageResult([diaries[0]], 201, 1, 1))
    await wrapper.get('[data-testid="page-size"]').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(api.listDiaryPage).toHaveBeenLastCalledWith(7, { page: 1, pageSize: 1 })
    for (const button of wrapper.findAll('button')) expect(button.attributes('type')).toBe('button')
  })

  it.each(['0', '101', '1.5', '', '-1'])('不发送非法每页条数 %s', async (size) => {
    const { wrapper } = await mountList()
    await wrapper.get('[data-testid="page-size"]').setValue(size)
    expect(wrapper.get('[data-testid="apply-page-size"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="page-size"]').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(api.listDiaryPage).toHaveBeenCalledTimes(1)
  })

  it('超末页响应采用服务返回的真实页码并禁用下一页', async () => {
    api.listDiaryPage.mockResolvedValueOnce(pageResult([diaries[0]], 41, 3))
    const { wrapper } = await mountList()
    expect(wrapper.get('[data-testid="page-status"]').text()).toContain('3 / 3')
    expect(wrapper.get('[data-testid="next-page"]').attributes('disabled')).toBeDefined()
  })

  it.each(['response', 'exception'])('加载错误不谎称空列表并支持重试：%s', async (mode) => {
    if (mode === 'response')
      api.listDiaryPage.mockResolvedValueOnce({ success: false, code: 'INTERNAL_ERROR' })
    else api.listDiaryPage.mockRejectedValueOnce(new Error('合成传输错误'))
    const { wrapper } = await mountList()
    expect(wrapper.find('.empty-state').exists()).toBe(false)
    expect(wrapper.find('[data-testid="diary-total"]').exists()).toBe(false)
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    await wrapper.get('[data-testid="retry-page"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="diary-card"]')).toHaveLength(2)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('切页失败保留上次有效卡片、总数和页码，重试同一目标页', async () => {
    api.listDiaryPage.mockResolvedValueOnce(pageResult(diaries, 45))
    const { wrapper } = await mountList()
    api.listDiaryPage.mockResolvedValueOnce({
      success: false,
      message: '合成失败',
      code: 'RATE_LIMITED'
    })
    await wrapper.get('[data-testid="next-page"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="diary-card"]')).toHaveLength(2)
    expect(wrapper.get('[data-testid="page-status"]').text()).toContain('1 / 3')
    expect(wrapper.get('[data-testid="diary-total"]').text()).toContain('45')
    api.listDiaryPage.mockResolvedValueOnce(pageResult([diaries[1]], 45, 2))
    await wrapper.get('[data-testid="retry-page"]').trigger('click')
    await flushPromises()
    expect(api.listDiaryPage).toHaveBeenLastCalledWith(7, { page: 2, pageSize: 20 })
    expect(wrapper.get('[data-testid="page-status"]').text()).toContain('2 / 3')
  })

  it('页面内迟到的第一页不能覆盖已经完成的第二页', async () => {
    api.listDiaryPage.mockResolvedValueOnce(pageResult(diaries, 45))
    const { wrapper } = await mountList()
    const first = deferred<IpcResponse<DiaryPageDTO>>()
    api.listDiaryPage.mockReturnValueOnce(first.promise)
    await wrapper.get('[data-testid="apply-page-size"]').trigger('click')
    api.listDiaryPage.mockResolvedValueOnce(pageResult([diaries[1]], 45, 2))
    await wrapper.get('[data-testid="next-page"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="page-status"]').text()).toContain('2 / 3')
    first.resolve(pageResult([diaries[0]], 999, 1))
    await flushPromises()
    expect(wrapper.get('[data-testid="page-status"]').text()).toContain('2 / 3')
    expect(wrapper.get('[data-testid="diary-total"]').text()).toContain('45')
    expect(wrapper.findAll('[data-testid="diary-card"]')).toHaveLength(1)
    expect(wrapper.text()).toContain('No title here.')
    expect(wrapper.text()).not.toContain('First entry')
  })

  it('被旧请求迟到失败不会覆盖新页错误状态或产生错误提示', async () => {
    api.listDiaryPage.mockResolvedValueOnce(pageResult(diaries, 45))
    const { wrapper } = await mountList()
    const first = deferred<IpcResponse<DiaryPageDTO>>()
    api.listDiaryPage.mockReturnValueOnce(first.promise)
    await wrapper.get('[data-testid="apply-page-size"]').trigger('click')
    api.listDiaryPage.mockResolvedValueOnce(pageResult([diaries[1]], 45, 2))
    await wrapper.get('[data-testid="next-page"]').trigger('click')
    await flushPromises()
    first.resolve({ success: false, code: 'INTERNAL_ERROR', message: '迟到错误' })
    await flushPromises()
    expect(messages.error).not.toHaveBeenCalled()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it.each(['success', 'auth', 'locked'] as const)(
    '同账号新会话不接受旧页迟到响应或再次发起操作：%s',
    async (mode) => {
      api.listDiaryPage.mockResolvedValueOnce(pageResult(diaries, 45))
      const { wrapper, router } = await mountList()
      const pending = deferred<IpcResponse<DiaryPageDTO>>()
      api.listDiaryPage.mockReturnValueOnce(pending.promise)
      await wrapper.get('[data-testid="next-page"]').trigger('click')
      const session = useUserStore()
      session.setUser({ ...user })
      const notebookStore = useNotebookStore()
      notebookStore.markUnlocked(7)
      const lock = vi.spyOn(notebookStore, 'lockNotebook')
      pending.resolve(
        mode === 'success'
          ? pageResult([diaries[1]], 900, 2)
          : {
              success: false,
              code: mode === 'auth' ? 'AUTH_REQUIRED' : 'NOTEBOOK_LOCKED'
            }
      )
      await flushPromises()
      expect(session.currentUser?.id).toBe(user.id)
      expect(notebookStore.isUnlocked(7)).toBe(true)
      expect(lock).not.toHaveBeenCalled()
      expect(router.currentRoute.value.name).toBe('Diaries')
      expect(wrapper.get('[data-testid="page-status"]').text()).toContain('1 / 3')
      expect(wrapper.get('[data-testid="diary-total"]').text()).toContain('45')
      await wrapper.get('[data-testid="apply-page-size"]').trigger('click')
      await wrapper.get('.lock-button').trigger('click')
      await flushPromises()
      expect(api.listDiaryPage).toHaveBeenCalledTimes(2)
      expect(api.lockNotebook).not.toHaveBeenCalled()
      expect(messages.error).not.toHaveBeenCalled()
    }
  )

  it('路由离开后旧请求不改列表镜像或导航，不全局登出', async () => {
    api.listDiaryPage.mockResolvedValueOnce(pageResult(diaries, 45))
    const { wrapper, router } = await mountList()
    const pending = deferred<IpcResponse<DiaryPageDTO>>()
    api.listDiaryPage.mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-testid="next-page"]').trigger('click')
    await router.push('/notebooks')
    pending.resolve({ success: false, code: 'AUTH_REQUIRED' })
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('Notebooks')
    expect(useUserStore().currentUser?.id).toBe(user.id)
    expect(wrapper.get('[data-testid="page-status"]').text()).toContain('1 / 3')
  })

  it('锁本成功使未完成分页失效并清空当前页卡片镜像', async () => {
    api.listDiaryPage.mockResolvedValueOnce(pageResult(diaries, 45))
    const { wrapper } = await mountList()
    const pending = deferred<IpcResponse<DiaryPageDTO>>()
    api.listDiaryPage.mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-testid="next-page"]').trigger('click')
    await wrapper.get('.lock-button').trigger('click')
    await flushPromises()
    pending.resolve(pageResult(diaries, 45, 2))
    await flushPromises()
    expect(wrapper.findAll('[data-testid="diary-card"]')).toHaveLength(0)
    expect(wrapper.find('[data-testid="diary-total"]').exists()).toBe(false)
    expect(useUserStore().currentUser?.id).toBe(user.id)
  })

  it('loads diaries for the notebook and renders cards', async () => {
    const { wrapper } = await mountList()
    expect(api.listDiaryPage).toHaveBeenCalledWith(7, { page: 1, pageSize: 20 })
    const cards = wrapper.findAll('[data-testid="diary-card"]')
    expect(cards).toHaveLength(2)
  })

  it('shows the title and truncated preview on each card', async () => {
    const { wrapper } = await mountList()
    const first = wrapper.findAll('[data-testid="diary-card"]')[0]
    expect(first.text()).toContain('First entry')
    expect(first.text()).toContain('A short preview text.')
  })

  it('falls back to the untitled label when a diary has no heading', async () => {
    const { wrapper } = await mountList()
    const second = wrapper.findAll('[data-testid="diary-card"]')[1]
    expect(second.text()).toContain('无标题')
  })

  it('renders an empty state when there are no diaries', async () => {
    api.listDiaryPage.mockResolvedValue(pageResult([]))
    const { wrapper } = await mountList()
    expect(wrapper.find('[data-testid="diary-card"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('还没有日记')
  })

  it('reports lock success and changes route only after the main process confirms it', async () => {
    const { wrapper, router } = await mountList()
    const store = useNotebookStore()
    const lockMirror = vi.spyOn(store, 'lockNotebook')
    await wrapper.find('.lock-button').trigger('click')
    await flushPromises()
    expect(api.lockNotebook).toHaveBeenCalledWith(7)
    expect(lockMirror).toHaveBeenCalledWith(7)
    expect(messages.success).toHaveBeenCalledWith('已锁定日记本')
    expect(router.currentRoute.value.name).toBe('Notebooks')
  })

  it.each(['response', 'exception'])(
    'never claims lock success when locking fails: %s',
    async (mode) => {
      if (mode === 'response')
        api.lockNotebook.mockResolvedValue({ success: false, message: 'lock rejected' })
      else api.lockNotebook.mockRejectedValue(new Error('synthetic transport failure'))
      const { wrapper, router } = await mountList()
      const lockMirror = vi.spyOn(useNotebookStore(), 'lockNotebook')
      await wrapper.find('.lock-button').trigger('click')
      await flushPromises()
      expect(lockMirror).not.toHaveBeenCalled()
      expect(messages.success).not.toHaveBeenCalled()
      expect(messages.error).toHaveBeenCalled()
      expect(router.currentRoute.value.name).toBe('Diaries')
      expect(wrapper.findAll('[data-testid="diary-card"]')).toHaveLength(2)
    }
  )

  it('navigates to the detail page when a card is clicked', async () => {
    const { wrapper, router } = await mountList()
    await wrapper.findAll('[data-testid="diary-card"]')[0].trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('DiaryDetail')
    expect(router.currentRoute.value.params.diaryId).toBe('1')
  })
})
