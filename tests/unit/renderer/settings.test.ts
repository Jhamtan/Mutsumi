import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import Settings from '../../../src/renderer/src/views/Settings.vue'

/**
 * Tests the settings page's close-behavior section: it has no header, loads the
 * persisted close action, and persists changes to the main process.
 */
// Native-select stand-in that forwards both v-model and change events.
const ElRadioGroupStub = defineComponent({
  props: { modelValue: { type: String, default: '' } },
  emits: ['update:modelValue', 'change'],
  setup(props, { emit, slots }) {
    return () =>
      h(
        'select',
        {
          value: props.modelValue,
          'data-testid': 'close-action',
          onChange: (event: Event) => {
            const value = (event.target as HTMLSelectElement).value
            emit('update:modelValue', value)
            emit('change', value)
          }
        },
        slots.default?.()
      )
  }
})

const ElRadioStub = defineComponent({
  props: { value: { type: String, default: '' } },
  setup(props, { slots }) {
    return () => h('option', { value: props.value }, slots.default?.())
  }
})

let api: {
  getCloseBehavior: ReturnType<typeof vi.fn>
  setCloseBehavior: ReturnType<typeof vi.fn>
}

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/settings', name: 'Settings', component: { template: '<div />' } }]
  })
}

async function mountSettings() {
  const router = makeRouter()
  await router.push('/settings')
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(Settings, {
    global: {
      plugins: [pinia, router],
      stubs: { ElRadioGroup: ElRadioGroupStub, ElRadio: ElRadioStub }
    }
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.stubGlobal('ElMessage', { success: vi.fn(), error: vi.fn(), warning: vi.fn() })
  api = {
    getCloseBehavior: vi
      .fn()
      .mockResolvedValue({ success: true, data: { action: 'quit', remember: false } }),
    setCloseBehavior: vi.fn().mockResolvedValue({ success: true })
  }
  ;(window as unknown as { api: unknown }).api = api
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Settings', () => {
  it('renders without a page header', async () => {
    const wrapper = await mountSettings()
    expect(wrapper.find('.page-head').exists()).toBe(false)
    expect(wrapper.find('h1').exists()).toBe(false)
  })

  it('loads and shows the persisted close behavior', async () => {
    const wrapper = await mountSettings()
    expect(api.getCloseBehavior).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('关闭应用时')
    expect(wrapper.text()).toContain('最小化至托盘')
    expect(wrapper.text()).toContain('退出')
    // 加载完成后默认选中持久化的「退出」
    expect(wrapper.get<HTMLSelectElement>('[data-testid="close-action"]').element.value).toBe(
      'quit'
    )
  })

  it('persists a new close action when the selection changes', async () => {
    const wrapper = await mountSettings()
    await wrapper.get('[data-testid="close-action"]').setValue('tray')
    expect(api.setCloseBehavior).toHaveBeenCalledExactlyOnceWith({ action: 'tray' })
  })
})
