/**
 * Composable that offers email domain suggestions while the user types,
 * with keyboard navigation and outside-click dismissal.
 */
import type { Ref } from 'vue'

/**
 * @param wrapperRef - element whose clicks should not dismiss the popup
 * @param inputValueRef - live value of the email input (two-way bound)
 */
export function useEmailSuggest(
  wrapperRef: Ref<HTMLElement | undefined>,
  inputValueRef: Ref<string> // pass inputValue directly
) {
  const isVisible = ref(false)
  const activeIndex = ref(0)
  // Common mailbox domains offered as completions.
  const suffixes = [
    '@gmail.com',
    '@outlook.com',
    '@qq.com',
    '@163.com',
    '@yahoo.com',
    '@hotmail.com',
    '@126.com',
    '@139.com',
    '@sina.com',
    '@foxmail.com',
    '@icloud.com',
    '@live.com'
  ]

  const suggestions = computed(() => {
    const val = inputValueRef.value.trim()
    if (!val) return []

    // If there's already an @, filter suffixes; otherwise append all
    const atIndex = val.indexOf('@')
    if (atIndex === -1) {
      return suffixes.map((suffix) => val + suffix)
    } else {
      const prefix = val.slice(0, atIndex)
      const typedSuffix = val.slice(atIndex)

      // If it's already a complete valid suffix, return an empty array so the popup closes
      if (suffixes.includes(typedSuffix)) {
        return []
      }

      return suffixes
        .filter((suffix) => suffix.startsWith(typedSuffix))
        .map((suffix) => prefix + suffix)
    }
  })

  // Core logic: open the list automatically as the user types
  watch(inputValueRef, (newVal) => {
    // As long as there's a value, this is forced to true
    activeIndex.value = 0
    isVisible.value = newVal.length > 0 && suggestions.value.length > 0
  })

  const handleKeydown = (e: Event) => {
    const event = e as KeyboardEvent
    if (!isVisible.value || suggestions.value.length === 0) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      activeIndex.value = (activeIndex.value + 1) % suggestions.value.length
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      // Wrap from the first suggestion to the last.
      activeIndex.value =
        (activeIndex.value - 1 + suggestions.value.length) % suggestions.value.length
    } else if (event.key === 'Enter') {
      event.preventDefault()
      selectSuggestion(suggestions.value[activeIndex.value])
    }
  }

  const selectSuggestion = async (item: string) => {
    inputValueRef.value = item
    activeIndex.value = 0
    // Wait for the watch to finish, then set the state to false
    await nextTick()
    isVisible.value = false
  }

  const handleFocus = () => {
    if (inputValueRef.value.length > 0) {
      isVisible.value = suggestions.value.length > 0
    }
  }

  // Handle outside clicks
  const handleClickOutside = (e: MouseEvent) => {
    if (wrapperRef.value && !wrapperRef.value.contains(e.target as Node)) {
      isVisible.value = false
    }
  }

  onMounted(() => document.addEventListener('mousedown', handleClickOutside))
  onUnmounted(() => document.removeEventListener('mousedown', handleClickOutside))

  return {
    isVisible,
    activeIndex,
    suggestions,
    handleKeydown,
    handleFocus,
    selectSuggestion
  }
}
