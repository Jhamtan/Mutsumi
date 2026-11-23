<script setup lang="ts">
import { useI18nStore } from '@renderer/store/i18n'
import type { CloseAction } from '@common/types'

/**
 * Global close dialog: shown when the user clicks the window "X" and the close
 * behavior has not been remembered. Lets the user choose to minimize to tray
 * or quit, optionally remembering the choice for next time.
 */
const i18nStore = useI18nStore()

const visible = ref(false)
const action = ref<CloseAction>('tray')
const remember = ref(false)

let unsubscribe: (() => void) | undefined

onMounted(() => {
  // The main process sends the current default action for pre-selection when the window is about to close and no choice is remembered.
  unsubscribe = window.api.onCloseQuery((defaultAction) => {
    action.value = defaultAction
    remember.value = false
    visible.value = true
  })
})

onBeforeUnmount(() => unsubscribe?.())

interface CloseOption {
  value: CloseAction
  icon: string
  title: string
  hint: string
}

const options = computed<CloseOption[]>(() => [
  {
    value: 'tray',
    icon: 'i-ep-minus',
    title: i18nStore.t.close.tray,
    hint: i18nStore.t.close.trayHint
  },
  {
    value: 'quit',
    icon: 'i-ep-switch-button',
    title: i18nStore.t.close.quitTitle,
    hint: i18nStore.t.close.quitHint
  }
])

/** Confirm-button label follows the selected action: minimize to tray / quit. */
const confirmLabel = () =>
  action.value === 'tray' ? i18nStore.t.close.tray : i18nStore.t.close.quit

function handleCancel() {
  visible.value = false
}

async function handleConfirm() {
  visible.value = false
  await window.api.resolveClose({ action: action.value, remember: remember.value })
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :show-close="false"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    width="min(440px, 92vw)"
    class="close-dialog"
    append-to-body
  >
    <div class="text-center">
      <h2 class="mb-1.5 text-lg font-bold text-ink">{{ i18nStore.t.close.title }}</h2>
      <p class="mb-5 text-[13px] text-ink-muted">{{ i18nStore.t.close.subtitle }}</p>
    </div>

    <div class="flex flex-col gap-3">
      <button
        v-for="opt in options"
        :key="opt.value"
        type="button"
        role="radio"
        :aria-checked="action === opt.value"
        class="flex w-full cursor-pointer items-center gap-3 rounded-2xl px-4 py-3.5 transition-colors border-none"
        :class="
          action === opt.value
            ? 'bg-brand-100 hover:bg-[#d3eede]'
            : 'bg-[#f7f9f8] hover:bg-[#eef3f1]'
        "
        @click="action = opt.value"
      >
        <span
          class="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-white text-lg text-brand-700"
          aria-hidden="true"
        >
          <span :class="opt.icon"></span>
        </span>
        <span class="flex min-w-0 flex-col text-left">
          <span
            class="text-sm font-semibold"
            :class="action === opt.value ? 'text-brand-700' : 'text-ink'"
          >
            {{ opt.title }}
          </span>
          <span class="mt-0.5 text-xs text-ink-soft">{{ opt.hint }}</span>
        </span>
        <span
          class="close-radio"
          :class="{ checked: action === opt.value }"
          aria-hidden="true"
        ></span>
      </button>
    </div>

    <label
      class="mt-3 flex cursor-pointer items-start gap-2.5 rounded-xl px-6 py-2 transition-colors hover:bg-[#eef3f1]"
    >
      <input v-model="remember" type="checkbox" class="sr-only" />
      <span class="close-checkbox" :class="{ checked: remember }" aria-hidden="true"></span>
      <span class="flex flex-col">
        <span class="text-sm font-medium text-ink">{{ i18nStore.t.close.remember }}</span>
        <span class="mt-0.5 text-xs text-ink-soft">{{ i18nStore.t.close.rememberHint }}</span>
      </span>
    </label>

    <template #footer>
      <div class="flex items-center justify-end gap-3">
        <button
          type="button"
          class="cursor-pointer rounded-full border-none bg-transparent px-[22px] py-2.5 text-sm font-medium text-ink-muted transition-colors hover:bg-[#eef3f1]"
          data-testid="cancel-close"
          @click="handleCancel"
        >
          {{ i18nStore.t.close.cancel }}
        </button>
        <button
          type="button"
          class="cursor-pointer rounded-full border-none bg-brand-700 px-[22px] py-2.5 text-sm font-semibold text-white shadow-none transition-colors hover:bg-brand-600"
          data-testid="confirm-close"
          @click="handleConfirm"
        >
          {{ confirmLabel() }}
        </button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.close-dialog :deep(.el-dialog) {
  border-radius: 20px;
  box-shadow: none;
}

/* Single selection circles: Hollow when unselected, solid green dot when selected. */
.close-radio {
  position: relative;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  margin-left: auto;
  border: 2px solid #c5d9da;
  border-radius: 50%;
  transition: border-color 0.16s ease;
}

.close-radio.checked {
  border-color: #45a77e;
}

.close-radio.checked::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #45a77e;
}

/* Checkbox: Hollow if not selected, check green when checked */
.close-checkbox {
  position: relative;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  margin-top: 1px;
  border: 2px solid #c5d9da;
  border-radius: 5px;
  transition:
    background-color 0.16s ease,
    border-color 0.16s ease;
}

.close-checkbox.checked {
  border-color: #45a77e;
  background: #45a77e;
}

.close-checkbox.checked::after {
  content: '';
  position: absolute;
  top: 1px;
  left: 5px;
  width: 4px;
  height: 8px;
  border: solid #fff;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}
</style>
