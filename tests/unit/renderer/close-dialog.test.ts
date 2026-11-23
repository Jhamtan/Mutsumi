import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import CloseDialog from '../../../src/renderer/src/components/CloseDialog.vue'

/**
 * Tests the global close dialog: it stays hidden until the main process asks,
 * renders the title/option cards/remember checkbox, and resolves the choice.
 */
// Passthrough stub that only renders content while `modelValue` is true.
const ElDialogStub = defineComponent({
  props: { modelValue: { type: Boolean, default: false } },
  emits: ['update:modelValue'],
  setup(props, { slots }) {
    return () =>
      props.modelValue
        ? h('div', { class: 'el-dialog-stub' }, [slots.default?.(), slots.footer?.()])
        : h('div')
  }
})

let api: {
  onCloseQuery: ReturnType<typeof vi.fn>
  resolveClose: ReturnType<typeof vi.fn>
}
let closeQueryCallback: ((action: string) => void) | undefined

function mountDialog() {
  const pinia = createPinia()
  setActivePinia(pinia)
  return mount(CloseDialog, {
    global: {
      plugins: [pinia],
      stubs: { ElDialog: ElDialogStub }
    }
  })
}

beforeEach(() => {
  closeQueryCallback = undefined
  api = {
    onCloseQuery: vi.fn((callback: (action: string) => void) => {
      closeQueryCallback = callback
      return () => {}
    }),
    resolveClose: vi.fn().mockResolvedValue({ success: true })
  }
  ;(window as unknown as { api: unknown }).api = api
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CloseDialog', () => {
  it('is hidden until the main process sends a close query', async () => {
    const wrapper = mountDialog()
    expect(wrapper.find('.el-dialog-stub').exists()).toBe(false)

    closeQueryCallback?.('tray')
    await nextTick()

    expect(wrapper.find('.el-dialog-stub').exists()).toBe(true)
    expect(wrapper.text()).toContain('关闭 Mutsumi?')
    expect(wrapper.text()).toContain('选择关闭窗口后的操作')
  })

  it('renders the title, option cards and remember checkbox', async () => {
    const wrapper = mountDialog()
    closeQueryCallback?.('tray')
    await nextTick()

    expect(wrapper.findAll('[role="radio"]')).toHaveLength(2)
    expect(wrapper.text()).toContain('最小化至托盘')
    expect(wrapper.text()).toContain('隐藏窗口，继续在后台运行')
    expect(wrapper.text()).toContain('退出 Mutsumi')
    expect(wrapper.text()).toContain('结束运行并关闭应用')
    expect(wrapper.text()).toContain('记住我的选择')
    expect(wrapper.text()).toContain('下次关闭窗口时不再询问')
    expect(wrapper.text()).toContain('取消')
  })

  it('pre-selects the tray action by default', async () => {
    const wrapper = mountDialog()
    closeQueryCallback?.('tray')
    await nextTick()
    expect(wrapper.get('[data-testid="confirm-close"]').text()).toBe('最小化至托盘')
  })

  it('pre-selects the quit action forwarded by the main process', async () => {
    const wrapper = mountDialog()
    closeQueryCallback?.('quit')
    await nextTick()
    expect(wrapper.get('[data-testid="confirm-close"]').text()).toBe('退出')
  })

  it('cancels without resolving the close', async () => {
    const wrapper = mountDialog()
    closeQueryCallback?.('tray')
    await nextTick()

    await wrapper.get('[data-testid="cancel-close"]').trigger('click')
    await nextTick()

    expect(api.resolveClose).not.toHaveBeenCalled()
    expect(wrapper.find('.el-dialog-stub').exists()).toBe(false)
  })

  it('resolves the chosen action and remember flag on confirm', async () => {
    const wrapper = mountDialog()
    closeQueryCallback?.('tray')
    await nextTick()

    await wrapper.findAll('[role="radio"]')[1].trigger('click')
    await wrapper.get('input[type="checkbox"]').setValue(true)
    await wrapper.get('[data-testid="confirm-close"]').trigger('click')
    await nextTick()

    expect(api.resolveClose).toHaveBeenCalledExactlyOnceWith({ action: 'quit', remember: true })
  })

  it('resets the remember flag each time the dialog reopens', async () => {
    const wrapper = mountDialog()
    closeQueryCallback?.('tray')
    await nextTick()
    await wrapper.get('input[type="checkbox"]').setValue(true)
    expect(wrapper.get<HTMLInputElement>('input[type="checkbox"]').element.checked).toBe(true)

    closeQueryCallback?.('quit')
    await nextTick()

    expect(wrapper.get<HTMLInputElement>('input[type="checkbox"]').element.checked).toBe(false)
  })
})
