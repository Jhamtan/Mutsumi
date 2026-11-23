import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import EmailInput from '../../../src/renderer/src/components/EmailInput.vue'

/**
 * Tests the EmailInput component: v-model wiring, attribute forwarding,
 * suggestion rendering, and keyboard/mouse selection with deferred blur.
 */
const blur = vi.fn()
const scrollIntoView = vi.fn()
// Minimal Element Plus input stub that forwards v-model, focus and keydown events.
const ElInputStub = defineComponent({
  props: { modelValue: { type: String, required: true } },
  emits: ['update:modelValue', 'focus', 'keydown'],
  setup(props, { emit, expose }) {
    expose({ blur })
    return () =>
      h('input', {
        value: props.modelValue,
        onInput: (event: Event) =>
          emit('update:modelValue', (event.target as HTMLInputElement).value),
        onFocus: (event: FocusEvent) => emit('focus', event),
        onKeydown: (event: KeyboardEvent) => emit('keydown', event)
      })
  }
})

function mountInput(modelValue = '') {
  return mount(EmailInput, {
    props: { modelValue },
    attrs: { 'aria-label': 'Email', disabled: false },
    global: { stubs: { ElInput: ElInputStub } }
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  // jsdom 不实现布局滚动，只替换该 DOM 方法；联想与 v-model 使用真实逻辑。
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView
  })
})

afterEach(() => {
  vi.useRealTimers()
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView
})

describe('EmailInput', () => {
  it('renders the initial model and forwards input attributes', () => {
    const wrapper = mountInput('test@example.com')
    expect(wrapper.get('input').element.value).toBe('test@example.com')
    expect(wrapper.get('input').attributes('placeholder')).toBe('example@domain.com')
    expect(wrapper.get('input').attributes('aria-label')).toBe('Email')
    expect(wrapper.find('ul').exists()).toBe(false)
  })

  it('emits model updates and renders suggestions when typing', async () => {
    const wrapper = mountInput()
    await wrapper.get('input').setValue('test')
    expect(wrapper.emitted('update:modelValue')).toEqual([['test']])
    expect(wrapper.findAll('li').map((item) => item.text())).toEqual([
      'test@gmail.com',
      'test@outlook.com',
      'test@qq.com',
      'test@163.com',
      'test@yahoo.com',
      'test@hotmail.com',
      'test@126.com',
      'test@139.com',
      'test@sina.com',
      'test@foxmail.com',
      'test@icloud.com',
      'test@live.com'
    ])
  })

  it('synchronizes external model changes', async () => {
    const wrapper = mountInput('initial')
    await wrapper.setProps({ modelValue: 'changed@qq.com' })
    expect(wrapper.get('input').element.value).toBe('changed@qq.com')
    expect(wrapper.find('ul').exists()).toBe(false)
  })

  it('opens existing partial input on focus and scrolls keyboard selection into view', async () => {
    const wrapper = mountInput('test')
    await wrapper.get('input').trigger('focus')
    expect(wrapper.findAll('li')).toHaveLength(12)
    await wrapper.get('input').trigger('keydown', { key: 'ArrowDown' })
    await nextTick()
    expect(wrapper.findAll('li')[1].classes()).toContain('font-medium')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    await wrapper.get('input').trigger('keydown', { key: 'Enter' })
    await nextTick()
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['test@outlook.com'])
    expect(wrapper.find('ul').exists()).toBe(false)
  })

  it('selects a hovered item on mousedown and delays blur until after model emission', async () => {
    const wrapper = mountInput()
    await wrapper.get('input').setValue('test')
    const item = wrapper.findAll('li')[2]
    await item.trigger('mouseenter')
    expect(item.classes()).toContain('font-medium')
    await item.trigger('mousedown')
    await nextTick()
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['test@qq.com'])
    expect(wrapper.find('ul').exists()).toBe(false)
    expect(blur).not.toHaveBeenCalled()
    // Blur is deferred so selecting a suggestion isn't lost; the timer fires after model emission.
    vi.runAllTimers()
    expect(blur).toHaveBeenCalledTimes(1)
  })

  it('can unmount before the delayed blur runs', async () => {
    const wrapper = mountInput()
    await wrapper.get('input').setValue('test')
    await wrapper.findAll('li')[0].trigger('mousedown')
    wrapper.unmount()
    expect(() => vi.runAllTimers()).not.toThrow()
    expect(blur).not.toHaveBeenCalled()
  })
})
