import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import MarkdownEditor from '../../../src/renderer/src/components/MarkdownEditor.vue'

/**
 * Tests the MarkdownEditor component: preview rendering, mode switching,
 * debounced autosave, formatting, theming, and draft image insertion.
 */
const ElTooltipStub = defineComponent({
  setup(_, { slots }) {
    return () => h('div', { class: 'tooltip-stub' }, [slots.default?.(), slots.content?.()])
  }
})

const ElDialogStub = defineComponent({
  props: { modelValue: Boolean },
  setup(props, { slots }) {
    return () =>
      props.modelValue ? h('div', { class: 'dialog-stub' }, [slots.default?.()]) : undefined
  }
})

function mountEditor(
  props: Partial<InstanceType<typeof MarkdownEditor>['$props']> & { modelValue?: string } = {}
) {
  return mount(MarkdownEditor, {
    props: { modelValue: '', ...props },
    global: { stubs: { ElTooltip: ElTooltipStub, ElDialog: ElDialogStub } }
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('MarkdownEditor', () => {
  it('renders the initial model and updates the live sanitized preview', async () => {
    const wrapper = mountEditor({ modelValue: '# Initial' })

    expect(wrapper.get('textarea').element.value).toBe('# Initial')
    expect(wrapper.get('[data-testid="markdown-preview"] h1').text()).toBe('Initial')

    await wrapper.get('textarea').setValue('# Changed\n\n<script>alert(1)</script>')

    expect(wrapper.emitted('update:modelValue')).toEqual([
      ['# Changed\n\n<script>alert(1)</script>']
    ])
    expect(wrapper.get('[data-testid="markdown-preview"] h1').text()).toBe('Changed')
    expect(wrapper.find('[data-testid="markdown-preview"] script').exists()).toBe(false)
  })

  it('synchronizes an external model change without auto-saving it', async () => {
    const wrapper = mountEditor({ modelValue: 'Initial' })

    await wrapper.setProps({ modelValue: 'External' })
    vi.runAllTimers()

    expect(wrapper.get('textarea').element.value).toBe('External')
    // External prop changes must not trigger the autosave debounce.
    expect(wrapper.emitted('save')).toBeUndefined()
  })

  it('switches between split and source-only modes', async () => {
    const wrapper = mountEditor({ modelValue: '**Preview**' })
    const modeButtons = wrapper.findAll('.mode-button')

    expect(wrapper.find('.preview-pane').exists()).toBe(true)
    await modeButtons[1].trigger('click')
    expect(wrapper.find('.preview-pane').exists()).toBe(false)
    expect(modeButtons[1].attributes('aria-pressed')).toBe('true')
    await modeButtons[0].trigger('click')
    expect(wrapper.find('.preview-pane').exists()).toBe(true)
  })

  it('debounces saves with the default and custom delays', async () => {
    const wrapper = mountEditor()

    await wrapper.get('textarea').setValue('one')
    vi.advanceTimersByTime(800)
    // The second edit resets the debounce timer, so only the final value is saved.
    await wrapper.get('textarea').setValue('two')
    vi.advanceTimersByTime(999)
    expect(wrapper.emitted('save')).toBeUndefined()
    vi.advanceTimersByTime(1)
    expect(wrapper.emitted('save')).toEqual([['two']])

    const fastWrapper = mountEditor({ autosaveDelay: 25 })
    await fastWrapper.get('textarea').setValue('fast')
    vi.advanceTimersByTime(25)
    expect(fastWrapper.emitted('save')).toEqual([['fast']])
  })

  it('cancels pending saves when delay changes or the component unmounts', async () => {
    const wrapper = mountEditor()

    await wrapper.get('textarea').setValue('pending')
    await wrapper.setProps({ autosaveDelay: 200 })
    vi.runAllTimers()
    expect(wrapper.emitted('save')).toBeUndefined()

    await wrapper.get('textarea').setValue('unmounted')
    wrapper.unmount()
    vi.runAllTimers()
    expect(wrapper.emitted('save')).toBeUndefined()
  })

  it('formats the draft, updates the model and saves the formatted value', async () => {
    const wrapper = mountEditor({ modelValue: 'Before\n- one\nAfter' })

    await wrapper.get('.format-button').trigger('click')
    const formatted = 'Before\n\n- one\n\nAfter\n'

    expect(wrapper.get('textarea').element.value).toBe(formatted)
    expect(wrapper.emitted('update:modelValue')).toEqual([[formatted]])
    expect(wrapper.emitted('format')).toEqual([[formatted]])
    vi.advanceTimersByTime(1000)
    expect(wrapper.emitted('save')).toEqual([[formatted]])
  })

  it('applies theme, dimensions, labels and accessible controls', async () => {
    const wrapper = mountEditor({
      theme: 'dark',
      width: 640,
      height: '70vh',
      placeholder: 'Write here',
      labels: { help: 'Show help', format: 'Polish' }
    })
    const root = wrapper.get('.markdown-editor')

    expect(root.attributes('data-theme')).toBe('dark')
    expect(root.attributes('style')).toContain('--markdown-editor-width: 640px')
    expect(root.attributes('style')).toContain('--markdown-editor-height: 70vh')
    expect(wrapper.get('textarea').attributes('placeholder')).toBe('Write here')
    expect(wrapper.find('[aria-label="Show help"]').exists()).toBe(true)
    expect(wrapper.get('.format-button').text()).toContain('Polish')
    expect(wrapper.text()).toContain('# Heading')
    expect(wrapper.text()).not.toContain('![Alt text](image.png)')

    await wrapper.get('.syntax-more').trigger('click')
    expect(wrapper.get('.dialog-stub').text()).toContain('![Alt text](image.png)')
    expect(wrapper.get('.dialog-stub').text()).toContain('- [x] Completed')
  })

  it('stores a selected image separately and inserts a short reference at the caret', async () => {
    // FileReader uses real asynchronous tasks in jsdom; advancing fake timers is not a completion signal.
    vi.useRealTimers()
    const wrapper = mountEditor({ modelValue: 'Before After', imageStorageKey: 'draft' })
    const textarea = wrapper.get('textarea').element
    textarea.setSelectionRange(7, 7)
    const file = new File(['image'], 'sample.png', { type: 'image/png' })
    const input = wrapper.get('[data-testid="image-input"]')

    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')
    await vi.waitFor(() => expect(wrapper.emitted('update:modelValue')).toBeDefined())
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('error')).toBeUndefined()

    const emitted = wrapper.emitted('update:modelValue')?.at(-1)?.[0] as string
    expect(emitted).toMatch(/^Before !\[sample\]\(draft-image:\/\/[a-zA-Z0-9_-]+\)/)
    expect(emitted).not.toContain('base64')
    expect(emitted).toContain('After')
    expect(wrapper.get('.markdown-preview img').attributes('alt')).toBe('sample')
    expect(wrapper.get('.markdown-preview img').attributes('src')).toMatch(
      /^data:image\/png;base64,/
    )
    expect(wrapper.find('[aria-label="Insert image"]').exists()).toBe(true)
  })

  it('rejects images larger than the configured draft limit', async () => {
    const wrapper = mountEditor({ maxImageSize: 3, imageStorageKey: 'draft' })
    const input = wrapper.get('[data-testid="image-input"]')
    const file = new File(['large'], 'large.png', { type: 'image/png' })

    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')

    expect(wrapper.emitted('error')).toEqual([
      ['The selected image is too large for a local draft.']
    ])
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('prevents rendered links from navigating the app', async () => {
    const wrapper = mountEditor({ modelValue: '[Example](https://example.com)' })
    const link = wrapper.get('.markdown-preview a')

    // Both left and middle click must be intercepted to keep the app from navigating away.
    for (const type of ['click', 'auxclick']) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true })
      link.element.dispatchEvent(event)
      await wrapper.vm.$nextTick()
      expect(event.defaultPrevented).toBe(true)
    }
  })
})
