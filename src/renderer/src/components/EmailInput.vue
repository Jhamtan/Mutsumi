<script setup lang="ts">
import { useEmailSuggest } from '../composables/useEmailSuggest'

const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()

const inputRef = ref()
// Wrap modelValue in a ref so it can be mutated locally while emitting updates.
const inputValue = ref(props.modelValue)
const wrapperRef = ref<HTMLElement>()
// 2. Reference to the suggestion list element (for auto-scroll).
const listRef = ref<HTMLElement>()

const { isVisible, activeIndex, suggestions, handleKeydown, handleFocus, selectSuggestion } =
  useEmailSuggest(wrapperRef, inputValue)

// 3. Wrap selection so the list closes after choosing.
const onSelect = (item: string) => {
  selectSuggestion(item)
  isVisible.value = false // force the list closed
  // Delay the blur with setTimeout so the parent has finished updating v-model,
  // avoiding Element Plus validating stale data.
  setTimeout(() => {
    inputRef.value?.blur()
  }, 0)
}

// 4. Watch activeIndex to auto-scroll the active item into view.
watch(activeIndex, async (newIndex) => {
  await nextTick()
  if (listRef.value) {
    const items = listRef.value.children
    const activeItem = items[newIndex] as HTMLElement
    if (activeItem) {
      // scrollIntoView({ block: 'nearest' }) computes the scroll distance itself:
      // it does nothing when the item is visible, otherwise scrolls to the nearest edge.
      activeItem.scrollIntoView({ block: 'nearest' })
    }
  }
})
watch(inputValue, (newVal) => {
  emit('update:modelValue', newVal)
})
watch(
  () => props.modelValue,
  (newVal) => {
    inputValue.value = newVal
  }
)
</script>

<template>
  <div ref="wrapperRef" class="relative w-full">
    <el-input
      ref="inputRef"
      v-model="inputValue"
      placeholder="example@domain.com"
      v-bind="$attrs"
      @focus="handleFocus"
      @keydown="handleKeydown"
    />
    <transition name="fade-slide">
      <ul
        v-if="isVisible && suggestions.length > 0"
        ref="listRef"
        class="absolute left-0 right-0 top-[calc(100%+8px)] z-50 py-1.5 rounded-xl bg-white/95 backdrop-blur-xl border-1 border-solid border-accent-100 shadow-panel max-h-48 overflow-y-auto m-0 pl-0 list-none"
      >
        <li
          v-for="(item, index) in suggestions"
          :key="item"
          class="mx-1.5 px-3 py-2 cursor-pointer transition-colors duration-150 text-sm rounded-lg"
          :class="[
            activeIndex === index
              ? 'bg-accent-50 text-accent-700 font-medium'
              : 'text-ink-muted hover:bg-canvas'
          ]"
          @mousedown.prevent="onSelect(item)"
          @mouseenter="activeIndex = index"
        >
          {{ item }}
        </li>
      </ul>
    </transition>
  </div>
</template>

<style scoped>
/* Smooth entry and exit animations for dropdown lists */
.fade-slide-enter-active,
.fade-slide-leave-active {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.fade-slide-enter-from {
  opacity: 0;
  transform: translateY(-10px) scale(0.98);
}

.fade-slide-leave-to {
  opacity: 0;
  transform: translateY(-10px) scale(0.98);
}

/* Hide the scrollbar but retain scrolling functionality to make the component look more sophisticated. */
ul::-webkit-scrollbar {
  width: 6px;
}
ul::-webkit-scrollbar-track {
  background: transparent;
}
ul::-webkit-scrollbar-thumb {
  background-color: rgba(137, 176, 174, 0.3);
  border-radius: 10px;
}
</style>
