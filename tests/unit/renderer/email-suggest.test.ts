import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { useEmailSuggest } from '../../../src/renderer/src/composables/useEmailSuggest'

/**
 * Tests the useEmailSuggest composable: suffix generation, filtering, keyboard
 * navigation, selection, and outside-click/unmount cleanup.
 */
function mountSuggest(initial = '') {
  const input = ref(initial)
  const element = ref<HTMLElement>()
  let api!: ReturnType<typeof useEmailSuggest>
  const wrapper = mount(
    defineComponent({
      setup() {
        api = useEmailSuggest(element, input)
        return () => h('div', { ref: element }, [h('button', 'Inside')])
      }
    }),
    { attachTo: document.body }
  )
  return { input, element, api, wrapper }
}

// Builds a cancelable event so defaultPrevented reflects whether the composable consumed it.
function keydown(api: ReturnType<typeof useEmailSuggest>, key: string) {
  const event = new KeyboardEvent('keydown', { key, cancelable: true })
  api.handleKeydown(event)
  return event
}

describe('useEmailSuggest', () => {
  it('starts hidden with no suggestions for empty input', () => {
    const { api } = mountSuggest()
    expect(api.suggestions.value).toEqual([])
    expect(api.isVisible.value).toBe(false)
    expect(api.activeIndex.value).toBe(0)
    api.handleFocus()
    expect(api.isVisible.value).toBe(false)
  })

  it('trims input and generates the supported suffixes in order', async () => {
    const { input, api } = mountSuggest()
    input.value = '  test  '
    await nextTick()
    expect(api.suggestions.value).toEqual([
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
    expect(api.isVisible.value).toBe(true)
  })

  it.each([
    ['test@g', ['test@gmail.com']],
    [
      'test@',
      [
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
      ]
    ],
    ['test@unknown', []],
    ['test@gmail.com', []],
    ['   ', []]
  ])('filters suggestions and visibility for %j', async (value, expected) => {
    const { input, api } = mountSuggest()
    input.value = value
    await nextTick()
    expect(api.suggestions.value).toEqual(expected)
    expect(api.isVisible.value).toBe(expected.length > 0)
  })

  it('wraps keyboard navigation and resets the selection when input changes', async () => {
    const { input, api } = mountSuggest('test')
    api.handleFocus()
    expect(keydown(api, 'ArrowUp').defaultPrevented).toBe(true)
    // ArrowUp from the start wraps around to the last of the twelve suggestions.
    expect(api.activeIndex.value).toBe(11)
    keydown(api, 'ArrowDown')
    expect(api.activeIndex.value).toBe(0)
    keydown(api, 'ArrowDown')
    expect(api.activeIndex.value).toBe(1)
    input.value = 'other'
    await nextTick()
    expect(api.activeIndex.value).toBe(0)
    input.value = ''
    await nextTick()
    expect(api.isVisible.value).toBe(false)
  })

  it('selects the highlighted suggestion with Enter and stays closed after the watcher', async () => {
    const { input, api } = mountSuggest('test')
    api.handleFocus()
    keydown(api, 'ArrowDown')
    expect(keydown(api, 'Enter').defaultPrevented).toBe(true)
    await nextTick()
    expect(input.value).toBe('test@outlook.com')
    expect(api.activeIndex.value).toBe(0)
    expect(api.isVisible.value).toBe(false)
  })

  it('supports direct selection and does not reopen a completed email on focus', async () => {
    const { input, api } = mountSuggest('test')
    api.handleFocus()
    await api.selectSuggestion('test@qq.com')
    expect(input.value).toBe('test@qq.com')
    expect(api.isVisible.value).toBe(false)
    api.handleFocus()
    expect(api.isVisible.value).toBe(false)
  })

  it('does not consume unrelated keys or navigation when hidden or empty', () => {
    const { api } = mountSuggest('test')
    expect(keydown(api, 'ArrowDown').defaultPrevented).toBe(false)
    expect(api.activeIndex.value).toBe(0)
    api.handleFocus()
    expect(keydown(api, 'Tab').defaultPrevented).toBe(false)
    const empty = mountSuggest().api
    empty.isVisible.value = true
    expect(keydown(empty, 'Enter').defaultPrevented).toBe(false)
  })

  it('keeps the list open for inside clicks and closes it for outside clicks', async () => {
    const { api, wrapper, element } = mountSuggest('test')
    api.handleFocus()
    await wrapper.get('button').trigger('mousedown')
    expect(api.isVisible.value).toBe(true)
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(api.isVisible.value).toBe(false)
    api.handleFocus()
    element.value = undefined
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(api.isVisible.value).toBe(true)
  })

  it('removes the exact outside-click listener on unmount', () => {
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')
    const { wrapper, api } = mountSuggest('test')
    // Capture the listener registered on focus to verify unmount removes the exact same one.
    const listener = add.mock.calls.find(([type]) => type === 'mousedown')![1]
    api.handleFocus()
    wrapper.unmount()
    expect(remove).toHaveBeenCalledWith('mousedown', listener)
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(api.isVisible.value).toBe(true)
  })
})
