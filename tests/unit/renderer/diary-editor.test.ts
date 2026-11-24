import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import DiaryEditor from '../../../src/renderer/src/views/diary/DiaryEditor.vue'
import type { DiaryDTO, IpcResponse, UserDTO } from '../../../src/common/types'
import { useUserStore } from '../../../src/renderer/src/store/user'
import { useNotebookStore } from '../../../src/renderer/src/store/notebook'

/**
 * Tests the diary editor: create mode builds a create payload, edit mode loads
 * and builds an update payload, and both navigate to the detail page on save.
 */
const ElSkeletonStub = { template: '<div class="el-skeleton-stub"></div>' }
const ElDatePickerStub = defineComponent({
  inheritAttrs: false,
  props: {
    modelValue: { type: [Date, String, Object], default: null },
    format: String,
    placeholder: String
  },
  emits: ['update:modelValue'],
  setup() {
    return () => h('input', { 'data-testid': 'time-picker' })
  }
})
const MarkdownEditorStub = defineComponent({
  inheritAttrs: false,
  props: {
    modelValue: { type: String, default: '' },
    labels: { type: Object, default: () => ({}) },
    imageStorageKey: String,
    resolvePersistentImage: Function,
    placeholder: String,
    height: [String, Number]
  },
  emits: ['update:modelValue', 'save'],
  setup(props, { emit }) {
    return () =>
      h('textarea', {
        value: props.modelValue,
        'data-testid': 'markdown-input',
        onInput: (event: Event) =>
          emit('update:modelValue', (event.target as HTMLTextAreaElement).value)
      })
  }
})

const diary: DiaryDTO = {
  id: 5,
  uuid: '55555555-5555-4555-8555-555555555555',
  notebookId: 7,
  occurredAt: '2026-11-07T09:00:00.000Z',
  createdAt: '2026-11-07T09:00:00.000Z',
  updatedAt: '2026-11-07T09:00:00.000Z',
  markdown: '# Old content',
  images: []
}

const sessionUser: UserDTO = {
  id: 31,
  name: 'Draft user',
  email: 'draft@example.test',
  createdAt: diary.createdAt,
  updatedAt: diary.updatedAt
}
const newDraftKey = 'user:31:diary:new:7'
const editDraftKey = 'user:31:diary:7:5'
function storeDraft(key: string, content: string, diaryId: number | null = null) {
  localStorage.setItem(
    key,
    JSON.stringify({
      version: 1,
      markdown: content,
      occurredAt: diary.occurredAt,
      diaryId
    })
  )
}
function readStoredDraft(key = newDraftKey) {
  const raw = localStorage.getItem(key)
  return raw
    ? (JSON.parse(raw) as { markdown: string; occurredAt: string | null; diaryId: number | null })
    : null
}
function deferredDiary() {
  let resolve!: (value: IpcResponse<DiaryDTO>) => void
  const promise = new Promise<IpcResponse<DiaryDTO>>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

let api: {
  getDiary: ReturnType<typeof vi.fn>
  createDiary: ReturnType<typeof vi.fn>
  updateDiary: ReturnType<typeof vi.fn>
}

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/notebooks', component: { template: '<div />' } },
      { path: '/login', component: { template: '<div />' } },
      { path: '/public', component: { template: '<div />' } },
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

async function mountEditor(
  props: { notebookId: string; diaryId?: string },
  options = { authenticated: true, unlocked: true }
) {
  const router = makeRouter()
  await router.push(`/notebooks/${props.notebookId}/diaries`)
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  const user = useUserStore(pinia)
  const notebooks = useNotebookStore(pinia)
  if (options.authenticated) user.setUser({ ...sessionUser })
  if (options.unlocked) notebooks.markUnlocked(Number(props.notebookId))
  const wrapper = mount(DiaryEditor, {
    props,
    global: {
      plugins: [pinia, router],
      stubs: {
        ElSkeleton: ElSkeletonStub,
        ElDatePicker: ElDatePickerStub,
        MarkdownEditor: MarkdownEditorStub
      }
    }
  })
  await flushPromises()
  return { wrapper, router, user, notebooks }
}

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('ElMessageBox', { confirm: vi.fn().mockResolvedValue('confirm') })
  vi.stubGlobal('ElMessage', { success: vi.fn(), error: vi.fn(), warning: vi.fn() })
  api = { getDiary: vi.fn(), createDiary: vi.fn(), updateDiary: vi.fn() }
  ;(window as unknown as { api: unknown }).api = api
  api.createDiary.mockResolvedValue({ success: true, data: { ...diary, id: 99 } })
  api.updateDiary.mockResolvedValue({ success: true, data: diary })
  api.getDiary.mockResolvedValue({ success: true, data: diary })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DiaryEditor', () => {
  it('creates a new diary and navigates to the detail page', async () => {
    const { wrapper, router } = await mountEditor({ notebookId: '7' })

    await wrapper.get('textarea').setValue('# Hello diary')
    await wrapper.get('[data-testid="save-button"]').trigger('click')
    await flushPromises()

    expect(api.createDiary).toHaveBeenCalledTimes(1)
    const payload = api.createDiary.mock.calls[0][0]
    expect(payload.notebookId).toBe(7)
    expect(payload.markdown).toBe('# Hello diary')
    expect(payload.images).toEqual([])
    expect(Number.isNaN(new Date(payload.occurredAt).getTime())).toBe(false)

    expect(router.currentRoute.value.name).toBe('DiaryDetail')
    expect(router.currentRoute.value.params.diaryId).toBe('99')
  })

  it('loads an existing diary and submits an update', async () => {
    const { wrapper, router } = await mountEditor({ notebookId: '7', diaryId: '5' })

    expect(api.getDiary).toHaveBeenCalledWith(7, 5)
    expect(wrapper.get('textarea').element.value).toBe('# Old content')

    await wrapper.get('textarea').setValue('# Updated content')
    await wrapper.get('[data-testid="save-button"]').trigger('click')
    await flushPromises()

    expect(api.updateDiary).toHaveBeenCalledTimes(1)
    const payload = api.updateDiary.mock.calls[0][0]
    expect(payload.diaryId).toBe(5)
    expect(payload.markdown).toBe('# Updated content')
    expect(router.currentRoute.value.params.diaryId).toBe('5')
  })

  it('cancels back to the diary list in create mode', async () => {
    const { wrapper, router } = await mountEditor({ notebookId: '7' })
    await wrapper.get('[data-testid="cancel-button"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('Diaries')
    expect(api.createDiary).not.toHaveBeenCalled()
  })

  it('restores a new entry draft with its selected time', async () => {
    storeDraft(newDraftKey, '# Recovered')
    const { wrapper } = await mountEditor({ notebookId: '7' })
    expect(wrapper.get('textarea').element.value).toBe('# Recovered')
    expect(wrapper.findComponent(ElDatePickerStub).props('modelValue')).toEqual(
      new Date(diary.occurredAt)
    )
    expect(wrapper.get('[data-testid="draft-status"]').text()).toContain('已恢复')
    expect(wrapper.text()).toContain('未加密缓存')
    expect(api.getDiary).not.toHaveBeenCalled()
    expect(api.createDiary).not.toHaveBeenCalled()
  })

  it('supports existing plain Markdown drafts without overwriting them during initialization', async () => {
    localStorage.setItem(newDraftKey, '# Legacy draft')
    const { wrapper } = await mountEditor({ notebookId: '7' })
    expect(wrapper.get('textarea').element.value).toBe('# Legacy draft')
    expect(localStorage.getItem(newDraftKey)).toBe('# Legacy draft')
  })

  it('loads the saved entry before applying an empty edit draft', async () => {
    storeDraft(editDraftKey, '', 5)
    const { wrapper } = await mountEditor({ notebookId: '7', diaryId: '5' })
    expect(api.getDiary).toHaveBeenCalledWith(7, 5)
    expect(wrapper.get('textarea').element.value).toBe('')
    expect(readStoredDraft(editDraftKey)?.markdown).toBe('')
  })

  it('persists content through the Markdown editor autosave event', async () => {
    const { wrapper } = await mountEditor({ notebookId: '7' })
    await wrapper.get('textarea').setValue('# Autosaved')
    expect(localStorage.getItem(newDraftKey)).toBeNull()
    wrapper.findComponent(MarkdownEditorStub).vm.$emit('save', '# Autosaved')
    await flushPromises()
    expect(readStoredDraft()?.markdown).toBe('# Autosaved')
    expect(wrapper.get('[data-testid="draft-status"]').text()).toContain('已保存在本机')
    expect(api.createDiary).not.toHaveBeenCalled()
  })

  it('persists time-only edits and retains a cleared time', async () => {
    const { wrapper } = await mountEditor({ notebookId: '7' })
    wrapper.findComponent(ElDatePickerStub).vm.$emit('update:modelValue', null)
    await flushPromises()
    expect(readStoredDraft()?.occurredAt).toBeNull()
    await wrapper.get('[data-testid="save-button"]').trigger('click')
    expect(api.createDiary).not.toHaveBeenCalled()
    expect(ElMessage.warning).toHaveBeenCalled()
  })

  it('flushes the latest pending draft before leaving and restores it when reopened', async () => {
    const first = await mountEditor({ notebookId: '7' })
    await first.wrapper.get('textarea').setValue('# Last keystroke')
    await first.router.push('/public')
    first.wrapper.unmount()
    expect(readStoredDraft()?.markdown).toBe('# Last keystroke')
    const second = await mountEditor({ notebookId: '7' })
    expect(second.wrapper.get('textarea').element.value).toBe('# Last keystroke')
  })

  it('flushes before a renderer reload and removes its unload listener on unmount', async () => {
    const { wrapper } = await mountEditor({ notebookId: '7' })
    await wrapper.get('textarea').setValue('# Before reload')
    window.dispatchEvent(new Event('beforeunload'))
    expect(readStoredDraft()?.markdown).toBe('# Before reload')
    wrapper.unmount()
    localStorage.removeItem(newDraftKey)
    window.dispatchEvent(new Event('beforeunload'))
    expect(localStorage.getItem(newDraftKey)).toBeNull()
  })

  it('clears only the submitted draft and its images after successful save', async () => {
    localStorage.setItem(`${newDraftKey}:image:photo`, 'data:image/png;base64,aW1hZ2U=')
    storeDraft('user:32:diary:new:7', '# Other account')
    const { wrapper } = await mountEditor({ notebookId: '7' })
    await wrapper.get('textarea').setValue('![photo](draft-image://photo)')
    await wrapper.get('[data-testid="save-button"]').trigger('click')
    await flushPromises()
    expect(api.createDiary.mock.calls[0][0].images).toHaveLength(1)
    expect(localStorage.getItem(newDraftKey)).toBeNull()
    expect(localStorage.getItem(`${newDraftKey}:image:photo`)).toBeNull()
    expect(readStoredDraft('user:32:diary:new:7')?.markdown).toBe('# Other account')
    wrapper.findComponent(MarkdownEditorStub).vm.$emit('save', '![photo](draft-image://photo)')
    wrapper.unmount()
    expect(localStorage.getItem(newDraftKey)).toBeNull()
  })

  it('keeps the draft and image bytes when the formal save fails', async () => {
    localStorage.setItem(`${newDraftKey}:image:photo`, 'data:image/png;base64,aW1hZ2U=')
    api.createDiary.mockResolvedValue({ success: false, code: 'INTERNAL_ERROR' })
    const { wrapper, router } = await mountEditor({ notebookId: '7' })
    await wrapper.get('textarea').setValue('![photo](draft-image://photo)')
    await wrapper.get('[data-testid="save-button"]').trigger('click')
    await flushPromises()
    expect(readStoredDraft()?.markdown).toContain('draft-image://photo')
    expect(localStorage.getItem(`${newDraftKey}:image:photo`)).not.toBeNull()
    expect(router.currentRoute.value.name).toBe('Diaries')
  })

  it('keeps newer edits when an older save completes and updates the created entry on retry', async () => {
    const pending = deferredDiary()
    api.createDiary.mockReturnValueOnce(pending.promise)
    const { wrapper, router } = await mountEditor({ notebookId: '7' })
    await wrapper.get('textarea').setValue('# Submitted')
    await wrapper.get('[data-testid="save-button"]').trigger('click')
    wrapper.findComponent(MarkdownEditorStub).vm.$emit('update:modelValue', '# Newer edits')
    pending.resolve({ success: true, data: { ...diary, id: 99, markdown: '# Submitted' } })
    await flushPromises()
    expect(readStoredDraft()).toMatchObject({ markdown: '# Newer edits', diaryId: 99 })
    expect(router.currentRoute.value.name).toBe('Diaries')
    api.updateDiary.mockResolvedValue({
      success: true,
      data: { ...diary, id: 99, markdown: '# Newer edits' }
    })
    await wrapper.get('[data-testid="save-button"]').trigger('click')
    await flushPromises()
    expect(api.createDiary).toHaveBeenCalledTimes(1)
    expect(api.updateDiary.mock.calls[0][0]).toMatchObject({
      diaryId: 99,
      markdown: '# Newer edits'
    })
    expect(localStorage.getItem(newDraftKey)).toBeNull()
  })

  it('resumes an already-created entry retained by a new-entry draft', async () => {
    storeDraft(newDraftKey, '# Newer edits', 99)
    api.getDiary.mockResolvedValue({ success: true, data: { ...diary, id: 99 } })
    const { wrapper } = await mountEditor({ notebookId: '7' })
    expect(api.getDiary).toHaveBeenCalledWith(7, 99)
    expect(wrapper.get('textarea').element.value).toBe('# Newer edits')
    api.updateDiary.mockResolvedValue({ success: true, data: { ...diary, id: 99 } })
    await wrapper.get('[data-testid="save-button"]').trigger('click')
    await flushPromises()
    expect(api.createDiary).not.toHaveBeenCalled()
    expect(api.updateDiary.mock.calls[0][0].diaryId).toBe(99)
  })

  it('ignores older autosave values rather than overwriting the latest text', async () => {
    const { wrapper } = await mountEditor({ notebookId: '7' })
    await wrapper.get('textarea').setValue('# Current')
    wrapper.findComponent(MarkdownEditorStub).vm.$emit('save', '# Old')
    expect(localStorage.getItem(newDraftKey)).toBeNull()
    wrapper.findComponent(MarkdownEditorStub).vm.$emit('save', '# Current')
    expect(readStoredDraft()?.markdown).toBe('# Current')
  })

  it('does not read drafts belonging to another account or notebook', async () => {
    storeDraft('user:32:diary:new:7', '# Other user')
    storeDraft('user:31:diary:new:8', '# Other notebook')
    const { wrapper } = await mountEditor({ notebookId: '7' })
    expect(wrapper.get('textarea').element.value).toBe('')
    expect(readStoredDraft('user:32:diary:new:7')?.markdown).toBe('# Other user')
    expect(readStoredDraft('user:31:diary:new:8')?.markdown).toBe('# Other notebook')
  })

  it('does not restore private drafts while anonymous or the notebook is locked', async () => {
    storeDraft(newDraftKey, '# Private')
    const anonymous = await mountEditor(
      { notebookId: '7' },
      { authenticated: false, unlocked: false }
    )
    expect(anonymous.wrapper.get('textarea').element.value).toBe('')
    anonymous.wrapper.unmount()
    const locked = await mountEditor({ notebookId: '7' }, { authenticated: true, unlocked: false })
    expect(locked.wrapper.get('textarea').element.value).toBe('')
    expect(readStoredDraft()?.markdown).toBe('# Private')
  })

  it('rejects corrupt draft envelopes without overwriting a saved entry', async () => {
    const raw = JSON.stringify({
      version: 1,
      markdown: 123,
      occurredAt: diary.occurredAt,
      diaryId: 5
    })
    localStorage.setItem(editDraftKey, raw)
    const { wrapper } = await mountEditor({ notebookId: '7', diaryId: '5' })
    expect(wrapper.get('textarea').element.value).toBe('# Old content')
    expect(wrapper.get('[data-testid="draft-status"]').text()).toContain('格式不可用')
    expect(localStorage.getItem(editDraftKey)).toBe(raw)
    expect(wrapper.get('[data-testid="discard-draft"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('[data-testid="discard-draft"]').trigger('click')
    await flushPromises()
    expect(localStorage.getItem(editDraftKey)).toBeNull()
    expect(wrapper.get('textarea').element.value).toBe('# Old content')
  })

  it('does not display cached text when the main process reports a locked notebook', async () => {
    storeDraft(editDraftKey, '# Private', 5)
    api.getDiary.mockResolvedValue({ success: false, code: 'NOTEBOOK_LOCKED' })
    const { wrapper, router } = await mountEditor({ notebookId: '7', diaryId: '5' })
    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(router.currentRoute.value.path).toBe('/notebooks')
    expect(readStoredDraft(editDraftKey)?.markdown).toBe('# Private')
  })

  it('keeps the editor usable after a draft storage quota error', async () => {
    const { wrapper } = await mountEditor({ notebookId: '7' })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota')
    })
    await wrapper.get('textarea').setValue('# Still editable')
    wrapper.findComponent(MarkdownEditorStub).vm.$emit('save', '# Still editable')
    wrapper.findComponent(MarkdownEditorStub).vm.$emit('save', '# Still editable')
    await flushPromises()
    expect(wrapper.get('textarea').element.value).toBe('# Still editable')
    expect(ElMessage.warning).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="draft-status"]').text()).toContain('保存失败')
    await wrapper.get('[data-testid="save-button"]').trigger('click')
    await flushPromises()
    expect(api.createDiary).toHaveBeenCalledTimes(1)
  })

  it('does not let an old save response clear a newer sign-in draft for the same account', async () => {
    const pending = deferredDiary()
    api.createDiary.mockReturnValueOnce(pending.promise)
    const { wrapper, user, notebooks } = await mountEditor({ notebookId: '7' })
    await wrapper.get('textarea').setValue('# Old session')
    await wrapper.get('[data-testid="save-button"]').trigger('click')
    user.setUser({ ...sessionUser, name: 'New sign-in' })
    notebooks.markUnlocked(7)
    storeDraft(newDraftKey, '# New session')
    pending.resolve({ success: true, data: diary })
    await flushPromises()
    wrapper.findComponent(MarkdownEditorStub).vm.$emit('save', '# Old session')
    wrapper.unmount()
    expect(readStoredDraft()?.markdown).toBe('# New session')
  })

  it('does not write an abandoned page under changed notebook props', async () => {
    const { wrapper } = await mountEditor({ notebookId: '7' })
    await wrapper.get('textarea').setValue('# Old scope')
    await wrapper.setProps({ notebookId: '8' })
    wrapper.findComponent(MarkdownEditorStub).vm.$emit('save', '# Old scope')
    wrapper.unmount()
    expect(localStorage.getItem(newDraftKey)).toBeNull()
    expect(localStorage.getItem('user:31:diary:new:8')).toBeNull()
  })

  it('discards a draft and its images only after confirmation', async () => {
    storeDraft(editDraftKey, '# Unsaved', 5)
    localStorage.setItem(`${editDraftKey}:image:photo`, 'data:image/png;base64,aW1hZ2U=')
    const { wrapper } = await mountEditor({ notebookId: '7', diaryId: '5' })
    ;(ElMessageBox.confirm as ReturnType<typeof vi.fn>).mockRejectedValueOnce('cancel')
    await wrapper.get('[data-testid="discard-draft"]').trigger('click')
    await flushPromises()
    expect(readStoredDraft(editDraftKey)?.markdown).toBe('# Unsaved')
    await wrapper.get('[data-testid="discard-draft"]').trigger('click')
    await flushPromises()
    expect(localStorage.getItem(editDraftKey)).toBeNull()
    expect(localStorage.getItem(`${editDraftKey}:image:photo`)).toBeNull()
    expect(wrapper.get('textarea').element.value).toBe('# Old content')
    expect(api.updateDiary).not.toHaveBeenCalled()
  })

  it('does not apply a discard confirmation after the account session changed', async () => {
    let confirm!: (value: string) => void
    const pending = new Promise<string>((done) => {
      confirm = done
    })
    ;(ElMessageBox.confirm as ReturnType<typeof vi.fn>).mockReturnValueOnce(pending)
    storeDraft(newDraftKey, '# Old session')
    const { wrapper, user, notebooks } = await mountEditor({ notebookId: '7' })
    await wrapper.get('[data-testid="discard-draft"]').trigger('click')
    user.setUser({ ...sessionUser, name: 'New sign-in' })
    notebooks.markUnlocked(7)
    storeDraft(newDraftKey, '# New session')
    confirm('confirm')
    await flushPromises()
    expect(readStoredDraft()?.markdown).toBe('# New session')
  })
})
