<script setup lang="ts">
import { useI18nStore } from '@renderer/store/i18n'
import { useUserStore } from '@renderer/store/user'
import { useSessionOperation } from '@renderer/composables/useSessionOperation'
import { formatDate } from '@renderer/utils/date'
import type { CloseAction, UpdateInfoDTO, UpdateStatusDTO } from '@common/types'

const router = useRouter()
const i18nStore = useI18nStore()
const userStore = useUserStore()
const operations = useSessionOperation()
const loggingOut = ref(false)

const user = computed(() => userStore.currentUser)

// Close-app behavior (minimize to tray / quit), loaded from the main process's persisted store.
const closeAction = ref<CloseAction>('tray')

// About / update state, loaded from the main process.
const appInfo = ref<UpdateInfoDTO>({ name: 'Mutsumi', version: '', repoUrl: '', isPackaged: false })
const updateStatus = ref<UpdateStatusDTO>({ state: 'idle' })
const autoCheck = ref(true)
let unsubscribeUpdate: (() => void) | undefined

onMounted(async () => {
  const operation = operations.capture()
  const response = await operation.call(() => window.api.getCloseBehavior())
  if (response?.success && response.data) closeAction.value = response.data.action

  const [infoRes, statusRes, settingsRes] = await Promise.all([
    operation.call(() => window.api.getAppInfo()),
    operation.call(() => window.api.getUpdateStatus()),
    operation.call(() => window.api.getUpdateSettings())
  ])
  if (infoRes?.success && infoRes.data) appInfo.value = infoRes.data
  if (statusRes?.success && statusRes.data) updateStatus.value = statusRes.data
  if (settingsRes?.success && settingsRes.data) autoCheck.value = settingsRes.data.autoCheck

  unsubscribeUpdate = window.api.onUpdateStatus((status) => {
    updateStatus.value = status
  })
})

onBeforeUnmount(() => {
  unsubscribeUpdate?.()
})

// Human-readable status line for the update section.
const statusText = computed(() => {
  const t = i18nStore.t.settings
  switch (updateStatus.value.state) {
    case 'checking':
      return t.checking
    case 'available':
      return t.updateAvailable.replace('{version}', updateStatus.value.version ?? '')
    case 'downloading':
      return t.downloading.replace('{percent}', String(updateStatus.value.percent ?? 0))
    case 'downloaded':
      return t.updateDownloaded.replace('{version}', updateStatus.value.version ?? '')
    case 'not-available':
      return t.upToDate
    case 'error':
      return appInfo.value.isPackaged ? t.checkFail : t.devModeHint
    default:
      return ''
  }
})

const checkingUpdate = computed(
  () => updateStatus.value.state === 'checking' || updateStatus.value.state === 'downloading'
)

async function handleCheckUpdate() {
  if (!appInfo.value.isPackaged) {
    ElMessage.info(i18nStore.t.settings.devModeHint)
    return
  }
  if (checkingUpdate.value) return
  const operation = operations.capture()
  const response = await operation.call(() => window.api.checkForUpdates())
  if (response?.success && response.data) updateStatus.value = response.data
}

function saveAutoCheck(value: string | number | boolean) {
  autoCheck.value = value === true
  const operation = operations.capture()
  void operation.call(() => window.api.setAutoCheck(autoCheck.value)).catch(() => undefined)
}

function handleInstallUpdate() {
  const operation = operations.capture()
  void operation.call(() => window.api.installUpdate()).catch(() => undefined)
}

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
        <h2 class="mb-4 text-[15px] font-semibold">{{ i18nStore.t.settings.about }}</h2>
        <dl class="m-0 grid gap-1">
          <div
            class="flex min-w-0 items-center justify-between gap-4 border-b border-[#eef5f3] py-2.5 last:border-b-0"
          >
            <dt class="shrink-0 text-xs text-ink-soft">{{ i18nStore.t.settings.version }}</dt>
            <dd class="m-0 text-[13px] font-medium">{{ appInfo.version }}</dd>
          </div>
          <div class="flex min-w-0 items-center justify-between gap-4 py-2.5">
            <dt class="shrink-0 text-xs text-ink-soft">{{ i18nStore.t.settings.repo }}</dt>
            <dd class="m-0 min-w-0 truncate text-[13px] font-medium">
              <a class="text-link" :href="appInfo.repoUrl" target="_blank" rel="noreferrer">
                {{ appInfo.repoUrl }}
              </a>
            </dd>
          </div>
        </dl>

        <div class="mt-3 flex items-center justify-between gap-4 border-t border-[#eef5f3] pt-4">
          <div class="flex min-w-0 items-center gap-2">
            <span
              v-if="updateStatus.state === 'downloading'"
              class="i-ep-loading inline-block animate-spin text-base text-ink-soft"
              aria-hidden="true"
            ></span>
            <span class="min-w-0 truncate text-[13px] text-ink-muted">{{ statusText }}</span>
          </div>
          <button
            v-if="updateStatus.state === 'downloaded'"
            type="button"
            class="btn-primary shrink-0"
            @click="handleInstallUpdate"
          >
            {{ i18nStore.t.settings.restartInstall }}
          </button>
          <button
            v-else
            type="button"
            class="btn-secondary shrink-0"
            :disabled="checkingUpdate"
            @click="handleCheckUpdate"
          >
            <span class="i-ep-refresh text-base" aria-hidden="true"></span>
            {{ checkingUpdate ? i18nStore.t.settings.checking : i18nStore.t.settings.checkUpdate }}
          </button>
        </div>

        <div class="mt-4 flex items-center justify-between gap-4 border-t border-[#eef5f3] pt-4">
          <div class="min-w-0">
            <p class="m-0 text-[13px] font-semibold">{{ i18nStore.t.settings.autoCheck }}</p>
            <p class="m-0 mt-0.5 text-xs text-ink-soft">{{ i18nStore.t.settings.autoCheckHint }}</p>
          </div>
          <el-switch v-model="autoCheck" @change="saveAutoCheck" />
        </div>
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
