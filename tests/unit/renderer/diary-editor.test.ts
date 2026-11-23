import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import DiaryEditor from '../../../src/renderer/src/views/diary/DiaryEditor.vue'
import type { DiaryDTO } from '../../../src/common/types'

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
  emits: ['update:modelValue'],
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

let api: {
  getDiary: ReturnType<typeof vi.fn>
  createDiary: ReturnType<typeof vi.fn>
  updateDiary: ReturnType<typeof vi.fn>
}

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
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

async function mountEditor(props: { notebookId: string; diaryId?: string }) {
  const router = makeRouter()
  await router.push('/notebooks/7/diaries')
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
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
  return { wrapper, router }
}

beforeEach(() => {
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
})
