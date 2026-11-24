import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { useNotebookStore } from '../../../src/renderer/src/store/notebook'
import { useUserStore } from '../../../src/renderer/src/store/user'
import { useI18nStore } from '../../../src/renderer/src/store/i18n'
import NotebookList from '../../../src/renderer/src/views/notebook/NotebookList.vue'
import type { NotebookSummaryDTO, UserDTO } from '../../../src/common/types'

/**
 * Tests the notebook session store: current notebook selection, unlocked-id
 * bookkeeping, locking, and reset.
 */
const notebook: NotebookSummaryDTO = {
  id: 1,
  uuid: '51b0554e-868e-45bf-aa2d-bdf74ed6436f',
  name: 'Journal',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

beforeEach(() => setActivePinia(createPinia()))

describe('useNotebookStore', () => {
  it('starts with no current notebook and no unlocked ids', () => {
    const store = useNotebookStore()
    expect(store.current).toBeNull()
    expect(store.unlockedIds).toEqual([])
    expect(store.isUnlocked(1)).toBe(false)
  })

  it('sets the current notebook and marks it unlocked', () => {
    const store = useNotebookStore()
    store.setCurrent(notebook)
    expect(store.current).toEqual(notebook)
    expect(store.isUnlocked(1)).toBe(true)
  })

  it('does not duplicate unlocked ids', () => {
    const store = useNotebookStore()
    store.markUnlocked(1)
    store.markUnlocked(1)
    expect(store.unlockedIds).toEqual([1])
  })

  it('locks a notebook and clears it if it was current', () => {
    const store = useNotebookStore()
    store.setCurrent(notebook)
    store.lockNotebook(1)
    expect(store.isUnlocked(1)).toBe(false)
    expect(store.current).toBeNull()
  })

  it('keeps other unlocked notebooks when locking one', () => {
    const store = useNotebookStore()
    store.markUnlocked(1)
    store.markUnlocked(2)
    store.lockNotebook(1)
    expect(store.isUnlocked(1)).toBe(false)
    expect(store.isUnlocked(2)).toBe(true)
  })

  it('reset clears all session state', () => {
    const store = useNotebookStore()
    store.setCurrent(notebook)
    store.markUnlocked(2)
    store.reset()
    expect(store.current).toBeNull()
    expect(store.unlockedIds).toEqual([])
  })
})

const user: UserDTO = {
  id: 42,
  name: '备份合成用户',
  email: 'backup@example.test',
  createdAt: notebook.createdAt,
  updatedAt: notebook.updatedAt
}
const importedNotebook: NotebookSummaryDTO = {
  ...notebook,
  id: 9,
  uuid: '91b0554e-868e-45bf-aa2d-bdf74ed6436f',
  name: '独立导入本'
}
const password = '存档密码123456'
const messages = { success: vi.fn(), error: vi.fn(), warning: vi.fn() }
const wrappers = new Set<{ unmount(): void }>()
const ElDialogStub = defineComponent({
  name: 'ElDialog',
  props: {
    modelValue: Boolean,
    showClose: Boolean,
    closeOnClickModal: Boolean,
    closeOnPressEscape: Boolean
  },
  emits: ['update:modelValue'],
  template: '<section v-if="modelValue"><slot /></section>'
})

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
  listNotebooks: ReturnType<typeof vi.fn<IAppApi['listNotebooks']>>
  importDiaryBackup: ReturnType<typeof vi.fn<IAppApi['importDiaryBackup']>>
  createNotebook: ReturnType<typeof vi.fn<IAppApi['createNotebook']>>
  unlockNotebook: ReturnType<typeof vi.fn<IAppApi['unlockNotebook']>>
}

async function mountList() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/notebooks', component: { template: '<div />' } },
      { path: '/notebooks/:notebookId/diaries', component: { template: '<div />' } },
      { path: '/login', component: { template: '<div />' } },
      { path: '/home', component: { template: '<div />' } }
    ]
  })
  await router.push('/notebooks')
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  useUserStore(pinia).setUser({ ...user })
  const wrapper = mount(NotebookList, {
    global: {
      plugins: [pinia, router],
      stubs: {
        ElDialog: ElDialogStub,
        ElSkeleton: { template: '<div />' },
        ElForm: { template: '<form><slot /></form>' },
        ElFormItem: { template: '<label><slot /></label>' },
        ElInput: true
      }
    }
  })
  wrappers.add(wrapper)
  await flushPromises()
  return { wrapper, router }
}

async function beginImport(wrapper: Awaited<ReturnType<typeof mountList>>['wrapper']) {
  await wrapper.get('[data-testid="import-backup"]').trigger('click')
  await wrapper.get('[data-testid="backup-password"]').setValue(password)
  await wrapper.get('[data-testid="import-backup-form"]').trigger('submit')
}

describe('NotebookList 日记备份', () => {
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
      setItem: vi.fn((key: string, value: string) => values.set(key, value))
    })
    for (const message of Object.values(messages)) message.mockClear()
    vi.stubGlobal('ElMessage', messages)
    api = {
      listNotebooks: vi.fn(),
      importDiaryBackup: vi.fn(),
      createNotebook: vi.fn(),
      unlockNotebook: vi.fn()
    }
    ;(window as unknown as { api: unknown }).api = api
    api.listNotebooks.mockResolvedValue({ success: true, data: [notebook] })
    api.importDiaryBackup.mockResolvedValue({
      success: true,
      data: { canceled: false, diaryCount: 45, notebook: importedNotebook }
    })
    api.createNotebook.mockResolvedValue({ success: true, data: notebook })
    api.unlockNotebook.mockResolvedValue({ success: true, data: notebook })
  })

  afterEach(() => {
    wrappers.forEach((wrapper) => wrapper.unmount())
    wrappers.clear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each([true, false])('空列表或已有本均有页头导入入口：empty=%s', async (empty) => {
    if (empty) api.listNotebooks.mockResolvedValueOnce({ success: true, data: [] })
    const { wrapper } = await mountList()
    expect(wrapper.findAll('[data-testid="notebook-card"]')).toHaveLength(empty ? 0 : 1)
    await wrapper.get('[data-testid="import-backup"]').trigger('click')
    expect(wrapper.get('[data-testid="import-backup-dialog"]').text()).toContain(
      useI18nStore().t.backup.importHint
    )
    expect(wrapper.get('[data-testid="backup-password"]').attributes('type')).toBe('password')
    expect(wrapper.find('input[type="file"]').exists()).toBe(false)
    expect(api.importDiaryBackup).not.toHaveBeenCalled()
  })

  it.each(['', '1234567', 'a'.repeat(129), '密'.repeat(86)])(
    '按日记本长度及 UTF-8 字节策略拒绝密码：%s',
    async (invalid) => {
      const { wrapper } = await mountList()
      await wrapper.get('[data-testid="import-backup"]').trigger('click')
      await wrapper.get('[data-testid="backup-password"]').setValue(invalid)
      expect(
        wrapper.get('[data-testid="submit-import-backup"]').attributes('disabled')
      ).toBeDefined()
      await wrapper.get('[data-testid="import-backup-form"]').trigger('submit')
      await flushPromises()
      expect(api.importDiaryBackup).not.toHaveBeenCalled()
      expect(messages.warning).toHaveBeenCalledWith(useI18nStore().t.backup.passwordInvalid)
    }
  )

  it.each(['12345678', 'a'.repeat(128), '密'.repeat(85), 'é'.repeat(128)])(
    '接受日记本密码边界（不限账号密码的 72 字节）：%s',
    async (valid) => {
      api.importDiaryBackup.mockResolvedValueOnce({ success: true, data: { canceled: true } })
      const { wrapper } = await mountList()
      await wrapper.get('[data-testid="import-backup"]').trigger('click')
      await wrapper.get('[data-testid="backup-password"]').setValue(valid)
      expect(
        wrapper.get('[data-testid="submit-import-backup"]').attributes('disabled')
      ).toBeUndefined()
      await wrapper.get('[data-testid="import-backup-form"]').trigger('submit')
      await flushPromises()
      expect(api.importDiaryBackup).toHaveBeenCalledExactlyOnceWith({ password: valid })
      expect(messages.warning).not.toHaveBeenCalled()
    }
  )

  it('成功导入新独立本并解锁进入日记，不覆盖现有列表、不在 renderer 选择路径', async () => {
    const { wrapper, router } = await mountList()
    const store = useNotebookStore()
    store.setCurrent(notebook)
    const setCurrent = vi.spyOn(store, 'setCurrent')
    const revision = useUserStore().sessionRevision
    await beginImport(wrapper)
    await flushPromises()
    expect(api.importDiaryBackup).toHaveBeenCalledExactlyOnceWith({ password })
    expect(setCurrent).toHaveBeenCalledExactlyOnceWith(importedNotebook)
    expect(store.current).toEqual(importedNotebook)
    expect(store.isUnlocked(importedNotebook.id)).toBe(true)
    expect(store.isUnlocked(notebook.id)).toBe(true)
    expect(wrapper.findAll('[data-testid="notebook-card"]')).toHaveLength(1)
    expect(wrapper.get('[data-testid="notebook-card"]').text()).toContain(notebook.name)
    expect(router.currentRoute.value.path).toBe('/notebooks/9/diaries')
    expect(wrapper.find('[data-testid="backup-password"]').exists()).toBe(false)
    expect(messages.success).toHaveBeenCalledWith(
      useI18nStore()
        .t.backup.importSuccess.replace('{count}', '45')
        .replace('{name}', importedNotebook.name)
    )
    expect(messages.error).not.toHaveBeenCalled()
    expect(useUserStore().sessionRevision).toBe(revision)
    expect(localStorage.setItem).not.toHaveBeenCalled()
    expect(api.createNotebook).not.toHaveBeenCalled()
    expect(api.unlockNotebook).not.toHaveBeenCalled()
  })

  it('成功提示按原样显示带有替换符的本名', async () => {
    const specialNotebook = { ...importedNotebook, name: '导入 $& $$ 本' }
    api.importDiaryBackup.mockResolvedValueOnce({
      success: true,
      data: { canceled: false, diaryCount: 0, notebook: specialNotebook }
    })
    const { wrapper } = await mountList()
    await beginImport(wrapper)
    await flushPromises()
    expect(messages.success).toHaveBeenCalledWith(
      useI18nStore()
        .t.backup.importSuccess.replace('{count}', '0')
        .replace('{name}', () => specialNotebook.name)
    )
  })

  it('保留新建本流程，新建 pending 不允许同时导入', async () => {
    const pending = deferred<Awaited<ReturnType<IAppApi['createNotebook']>>>()
    api.createNotebook.mockReturnValueOnce(pending.promise)
    const { wrapper, router } = await mountList()
    await wrapper.get('[data-testid="create-notebook"]').trigger('click')
    const inputs = wrapper.findAllComponents({ name: 'ElInput' })
    expect(inputs).toHaveLength(3)
    inputs[0].vm.$emit('update:modelValue', '新本')
    inputs[1].vm.$emit('update:modelValue', password)
    inputs[2].vm.$emit('update:modelValue', password)
    await wrapper.get('form').trigger('submit')
    expect(api.createNotebook).toHaveBeenCalledExactlyOnceWith({ name: '新本', password })
    expect(wrapper.get('[data-testid="import-backup"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="import-backup"]').trigger('click')
    expect(wrapper.find('[data-testid="import-backup-dialog"]').exists()).toBe(false)
    expect(api.importDiaryBackup).not.toHaveBeenCalled()
    pending.resolve({ success: true, data: notebook })
    await flushPromises()
    expect(useNotebookStore().current).toEqual(notebook)
    expect(router.currentRoute.value.path).toBe('/notebooks/1/diaries')
    expect(messages.success).toHaveBeenCalledWith(useI18nStore().t.notebook.createSuccess)
  })

  it('保留解锁本流程，解锁 pending 不允许同时导入', async () => {
    const pending = deferred<Awaited<ReturnType<IAppApi['unlockNotebook']>>>()
    api.unlockNotebook.mockReturnValueOnce(pending.promise)
    const { wrapper, router } = await mountList()
    await wrapper.get('[data-testid="notebook-card"]').trigger('click')
    wrapper.getComponent({ name: 'ElInput' }).vm.$emit('update:modelValue', password)
    await wrapper.get('form').trigger('submit')
    expect(api.unlockNotebook).toHaveBeenCalledExactlyOnceWith({
      notebookId: notebook.id,
      password
    })
    expect(wrapper.get('[data-testid="import-backup"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="import-backup"]').trigger('click')
    expect(api.importDiaryBackup).not.toHaveBeenCalled()
    pending.resolve({ success: true, data: notebook })
    await flushPromises()
    expect(useNotebookStore().current).toEqual(notebook)
    expect(router.currentRoute.value.path).toBe('/notebooks/1/diaries')
    expect(messages.success).toHaveBeenCalledWith(useI18nStore().t.notebook.unlockSuccess)
  })

  it('原生选文件取消静默保留当前数据，密码已清空，重输才能重试', async () => {
    api.importDiaryBackup.mockResolvedValueOnce({ success: true, data: { canceled: true } })
    const { wrapper, router } = await mountList()
    const store = useNotebookStore()
    store.setCurrent(notebook)
    const setCurrent = vi.spyOn(store, 'setCurrent')
    await beginImport(wrapper)
    await flushPromises()
    expect(messages.success).not.toHaveBeenCalled()
    expect(messages.error).not.toHaveBeenCalled()
    expect(setCurrent).not.toHaveBeenCalled()
    expect(store.current).toEqual(notebook)
    expect(store.isUnlocked(notebook.id)).toBe(true)
    expect(router.currentRoute.value.path).toBe('/notebooks')
    expect(wrapper.findAll('[data-testid="notebook-card"]')).toHaveLength(1)
    expect((wrapper.get('[data-testid="backup-password"]').element as HTMLInputElement).value).toBe(
      ''
    )
    expect(wrapper.get('[data-testid="submit-import-backup"]').attributes('disabled')).toBeDefined()
    expect(
      wrapper.get('[data-testid="cancel-import-backup"]').attributes('disabled')
    ).toBeUndefined()
    expect(localStorage.setItem).not.toHaveBeenCalled()
  })

  it.each([
    ['INVALID_NOTEBOOK_PASSWORD', 'passwordWrong'],
    ['INVALID_BACKUP', 'invalidArchive'],
    ['RATE_LIMITED', 'importFail'],
    ['NOTEBOOK_LOCKED', 'importFail']
  ] as const)('业务错误 %s 本地化且不改变当前本', async (code, key) => {
    api.importDiaryBackup.mockResolvedValueOnce({
      success: false,
      code,
      message: '内部异常详情或路径不向界面显示'
    })
    const { wrapper, router } = await mountList()
    const store = useNotebookStore()
    store.setCurrent(notebook)
    await beginImport(wrapper)
    await flushPromises()
    expect(messages.error).toHaveBeenCalledExactlyOnceWith(useI18nStore().t.backup[key])
    expect(messages.success).not.toHaveBeenCalled()
    expect(store.current).toEqual(notebook)
    expect(store.isUnlocked(notebook.id)).toBe(true)
    expect(useUserStore().currentUser?.id).toBe(user.id)
    expect(router.currentRoute.value.path).toBe('/notebooks')
    expect((wrapper.get('[data-testid="backup-password"]').element as HTMLInputElement).value).toBe(
      ''
    )
    expect(wrapper.get('[data-testid="import-backup"]').attributes('disabled')).toBeUndefined()
  })

  it.each(['exception', 'missing-data', 'missing-notebook'])(
    '导入异常/成功响应缺失本使用通用提示，不虚报成功：%s',
    async (mode) => {
      if (mode === 'exception')
        api.importDiaryBackup.mockRejectedValueOnce(new Error('合成传输错误'))
      else if (mode === 'missing-data')
        api.importDiaryBackup.mockResolvedValueOnce({ success: true })
      else
        api.importDiaryBackup.mockResolvedValueOnce({
          success: true,
          data: { canceled: false, diaryCount: 45 }
        })
      const { wrapper, router } = await mountList()
      const setCurrent = vi.spyOn(useNotebookStore(), 'setCurrent')
      await beginImport(wrapper)
      await flushPromises()
      expect(messages.error).toHaveBeenCalledExactlyOnceWith(useI18nStore().t.backup.importFail)
      expect(messages.success).not.toHaveBeenCalled()
      expect(setCurrent).not.toHaveBeenCalled()
      expect(router.currentRoute.value.path).toBe('/notebooks')
      expect(wrapper.get('[data-testid="import-backup"]').attributes('disabled')).toBeUndefined()
    }
  )

  it('导入 pending 清空并禁用密码，不允许重复导入、关闭或切换相关弹窗', async () => {
    const pending = deferred<Awaited<ReturnType<IAppApi['importDiaryBackup']>>>()
    api.importDiaryBackup.mockReturnValueOnce(pending.promise)
    const { wrapper, router } = await mountList()
    useNotebookStore().setCurrent(notebook)
    await beginImport(wrapper)
    expect(api.importDiaryBackup).toHaveBeenCalledExactlyOnceWith({ password })
    expect((wrapper.get('[data-testid="backup-password"]').element as HTMLInputElement).value).toBe(
      ''
    )
    for (const id of [
      'backup-password',
      'submit-import-backup',
      'cancel-import-backup',
      'import-backup',
      'create-notebook',
      'notebook-card'
    ]) {
      expect(wrapper.get(`[data-testid="${id}"]`).attributes('disabled')).toBeDefined()
    }
    expect(wrapper.get('[data-testid="submit-import-backup"]').attributes('aria-busy')).toBe('true')
    const dialog = wrapper.findAllComponents(ElDialogStub)[0]
    expect(dialog.props('showClose')).toBe(false)
    expect(dialog.props('closeOnClickModal')).toBe(false)
    expect(dialog.props('closeOnPressEscape')).toBe(false)
    dialog.vm.$emit('update:modelValue', false)
    await wrapper.get('[data-testid="cancel-import-backup"]').trigger('click')
    await wrapper.get('[data-testid="import-backup-form"]').trigger('submit')
    await wrapper.get('[data-testid="import-backup"]').trigger('click')
    await wrapper.get('[data-testid="create-notebook"]').trigger('click')
    await wrapper.get('[data-testid="notebook-card"]').trigger('click')
    await flushPromises()
    expect(dialog.props('modelValue')).toBe(true)
    expect(
      wrapper
        .findAllComponents(ElDialogStub)
        .slice(1)
        .every((item) => !item.props('modelValue'))
    ).toBe(true)
    expect(api.importDiaryBackup).toHaveBeenCalledTimes(1)
    expect(api.createNotebook).not.toHaveBeenCalled()
    expect(api.unlockNotebook).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/notebooks')
    pending.resolve({ success: true, data: { canceled: true } })
    await flushPromises()
    expect(dialog.props('showClose')).toBe(true)
    expect(
      wrapper.get('[data-testid="cancel-import-backup"]').attributes('disabled')
    ).toBeUndefined()
    expect(wrapper.get('[data-testid="create-notebook"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-testid="notebook-card"]').attributes('disabled')).toBeUndefined()
  })

  it.each(['cancel', 'dialog'] as const)('关闭密码弹窗清除密码，不调用 IPC：%s', async (close) => {
    const { wrapper } = await mountList()
    await wrapper.get('[data-testid="import-backup"]').trigger('click')
    await wrapper.get('[data-testid="backup-password"]').setValue(password)
    if (close === 'cancel')
      await wrapper.get('[data-testid="cancel-import-backup"]').trigger('click')
    else wrapper.findAllComponents(ElDialogStub)[0].vm.$emit('update:modelValue', false)
    await flushPromises()
    expect(wrapper.find('[data-testid="backup-password"]').exists()).toBe(false)
    await wrapper.get('[data-testid="import-backup"]').trigger('click')
    expect((wrapper.get('[data-testid="backup-password"]').element as HTMLInputElement).value).toBe(
      ''
    )
    expect(api.importDiaryBackup).not.toHaveBeenCalled()
    expect(localStorage.setItem).not.toHaveBeenCalled()
  })

  it.each(['account', 'route', 'unmount'] as const)(
    '生命周期离开清除未提交的密码：%s',
    async (change) => {
      const { wrapper, router } = await mountList()
      await wrapper.get('[data-testid="import-backup"]').trigger('click')
      await wrapper.get('[data-testid="backup-password"]').setValue(password)
      const state = wrapper.vm as unknown as { importPassword: string }
      expect(state.importPassword).toBe(password)
      if (change === 'account') useUserStore().setUser({ ...user, id: 99 })
      else if (change === 'route') await router.push('/home')
      else {
        wrapper.unmount()
        wrappers.delete(wrapper)
      }
      await flushPromises()
      expect(state.importPassword).toBe('')
      expect(api.importDiaryBackup).not.toHaveBeenCalled()
    }
  )

  it('导入 AUTH_REQUIRED 使用共享处理登出并跳登录，不叠加错误提示', async () => {
    api.importDiaryBackup.mockResolvedValueOnce({ success: false, code: 'AUTH_REQUIRED' })
    const { wrapper, router } = await mountList()
    useNotebookStore().setCurrent(notebook)
    await beginImport(wrapper)
    await flushPromises()
    expect(useUserStore().currentUser).toBeNull()
    expect(useNotebookStore().current).toBeNull()
    expect(useNotebookStore().isUnlocked(notebook.id)).toBe(false)
    expect(router.currentRoute.value.path).toBe('/login')
    expect(router.currentRoute.value.query.redirect).toBe('/notebooks')
    expect(messages.error).not.toHaveBeenCalled()
    expect(messages.success).not.toHaveBeenCalled()
  })

  describe.each(['account', 'same-session', 'route', 'unmount'] as const)(
    '导入 owner 失效：%s',
    (change) => {
      it.each(['success', 'AUTH_REQUIRED', 'INVALID_BACKUP', 'exception'] as const)(
        '忽略迟到 %s，不修改新会话、镜像、pending 状态或导航',
        async (result) => {
          const pending = deferred<Awaited<ReturnType<IAppApi['importDiaryBackup']>>>()
          api.importDiaryBackup.mockReturnValueOnce(pending.promise)
          const { wrapper, router } = await mountList()
          await beginImport(wrapper)
          if (change === 'account') useUserStore().setUser({ ...user, id: 99 })
          else if (change === 'same-session') useUserStore().setUser({ ...user })
          else if (change === 'route') await router.push('/home')
          else {
            wrapper.unmount()
            wrappers.delete(wrapper)
          }
          const pathAfterChange = router.currentRoute.value.fullPath
          const store = useNotebookStore()
          store.setCurrent(notebook)
          const setCurrent = vi.spyOn(store, 'setCurrent')
          const reset = vi.spyOn(store, 'reset')
          const lock = vi.spyOn(store, 'lockNotebook')
          if (result === 'exception') pending.reject(new Error('迟到合成异常'))
          else
            pending.resolve(
              result === 'success'
                ? {
                    success: true,
                    data: { canceled: false, diaryCount: 900, notebook: importedNotebook }
                  }
                : { success: false, code: result }
            )
          await flushPromises()
          expect(setCurrent).not.toHaveBeenCalled()
          expect(reset).not.toHaveBeenCalled()
          expect(lock).not.toHaveBeenCalled()
          expect(store.current).toEqual(notebook)
          expect(store.isUnlocked(importedNotebook.id)).toBe(false)
          expect(messages.success).not.toHaveBeenCalled()
          expect(messages.error).not.toHaveBeenCalled()
          expect(useUserStore().currentUser?.id).toBe(change === 'account' ? 99 : user.id)
          expect(router.currentRoute.value.fullPath).toBe(pathAfterChange)
          if (change !== 'unmount') {
            expect(
              wrapper.get('[data-testid="submit-import-backup"]').attributes('aria-busy')
            ).toBe('true')
            await wrapper.get('[data-testid="import-backup-form"]').trigger('submit')
            expect(api.importDiaryBackup).toHaveBeenCalledTimes(1)
          }
        }
      )
    }
  )
})
