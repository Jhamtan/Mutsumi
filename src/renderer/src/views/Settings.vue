<script setup lang="ts">
import { useI18nStore } from '@renderer/store/i18n'
import { useUserStore } from '@renderer/store/user'
import { useSessionOperation } from '@renderer/composables/useSessionOperation'
import { formatDate } from '@renderer/utils/date'
import type { CloseAction } from '@common/types'

const router = useRouter()
const i18nStore = useI18nStore()
const userStore = useUserStore()
const operations = useSessionOperation()
const loggingOut = ref(false)

const user = computed(() => userStore.currentUser)

// Close-app behavior (minimize to tray / quit), loaded from the main process's persisted store.
const closeAction = ref<CloseAction>('tray')

onMounted(async () => {
  const operation = operations.capture()
  const response = await operation.call(() => window.api.getCloseBehavior())
  if (response?.success && response.data) closeAction.value = response.data.action
})

// Persist immediately on change; only the action changes, never the "remember choice" flag.
function saveCloseAction(value: unknown) {
  if (value !== 'tray' && value !== 'quit') return
  closeAction.value = value
  const operation = operations.capture()
  void operation.call(() => window.api.setCloseBehavior({ action: value })).catch(() => undefined)
}

const handleLogout = async () => {
  if (loggingOut.value) return
  const attempt = userStore.beginLogout()
  if (attempt === undefined) return
  loggingOut.value = true
  try {
    const response = await window.api.logout()
    if (!response.success) {
      if (userStore.failLogout(attempt)) ElMessage.error('Logout failed')
      return
    }
    if (!userStore.completeLogout(attempt)) return
    ElMessage.success(i18nStore.t.nav.logoutSuccess)
    await router.replace('/login')
  } catch {
    if (userStore.failLogout(attempt)) ElMessage.error('Logout failed')
  } finally {
    loggingOut.value = false
  }
}
</script>

<template>
  <div class="page-container">
    <div class="mx-auto grid max-w-[720px] gap-[18px]">
      <section class="app-surface rounded-[18px] p-6">
        <h2 class="mb-4 text-[15px] font-semibold">{{ i18nStore.t.settings.account }}</h2>
        <dl class="m-0 grid gap-1">
          <div
            class="flex min-w-0 items-center justify-between gap-4 border-b border-[#eef5f3] py-2.5 last:border-b-0"
          >
            <dt class="shrink-0 text-xs text-ink-soft">{{ i18nStore.t.settings.name }}</dt>
            <dd class="m-0 text-[13px] font-medium">{{ user?.name }}</dd>
          </div>
          <div
            class="flex min-w-0 items-center justify-between gap-4 border-b border-[#eef5f3] py-2.5 last:border-b-0"
          >
            <dt class="shrink-0 text-xs text-ink-soft">{{ i18nStore.t.settings.email }}</dt>
            <dd class="m-0 truncate text-[13px] font-medium">{{ user?.email }}</dd>
          </div>
          <div
            class="flex min-w-0 items-center justify-between gap-4 border-b border-[#eef5f3] py-2.5 last:border-b-0"
          >
            <dt class="shrink-0 text-xs text-ink-soft">{{ i18nStore.t.settings.joined }}</dt>
            <dd class="m-0 text-[13px] font-medium">
              {{ user ? formatDate(user.createdAt, i18nStore.locale) : '' }}
            </dd>
          </div>
        </dl>
      </section>

      <section class="app-surface rounded-[18px] p-6">
        <h2 class="mb-4 text-[15px] font-semibold">{{ i18nStore.t.settings.language }}</h2>
        <div class="flex items-center justify-between gap-4">
          <span class="text-sm font-semibold">{{
            i18nStore.locale === 'zh' ? '中文' : 'English'
          }}</span>
          <button type="button" class="locale-button" @click="i18nStore.toggleLocale()">
            <span class="i-carbon-language text-base" aria-hidden="true"></span>
            {{ i18nStore.t.common.switchLanguage }}
          </button>
        </div>
      </section>

      <section class="app-surface rounded-[18px] p-6">
        <h2 class="mb-4 text-[15px] font-semibold">{{ i18nStore.t.settings.closeBehavior }}</h2>
        <el-radio-group v-model="closeAction" @change="saveCloseAction">
          <el-radio value="tray">{{ i18nStore.t.close.tray }}</el-radio>
          <el-radio value="quit">{{ i18nStore.t.close.quit }}</el-radio>
        </el-radio-group>
      </section>

      <section class="app-surface rounded-[18px] p-6">
        <p class="mb-4 text-xs leading-[1.7] text-ink-muted">{{ i18nStore.t.settings.note }}</p>
        <button
          type="button"
          class="btn-secondary logout-button"
          :disabled="loggingOut || userStore.logoutPending"
          @click="handleLogout"
        >
          <span class="i-ep-switch-button text-base" aria-hidden="true"></span>
          {{ i18nStore.t.settings.logout }}
        </button>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* Cover the width/height of  btn-secondary , used only on this page */
.logout-button {
  width: auto;
  min-height: 42px;
  padding: 0 20px;
}
</style>
