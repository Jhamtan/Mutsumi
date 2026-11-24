<script setup lang="ts">
import type { NotebookSummaryDTO } from '@common/types'
import { isValidNotebookPassword } from '@common/notebook-password'
import { useI18nStore } from '@renderer/store/i18n'
import { useNotebookStore } from '@renderer/store/notebook'
import { useUserStore } from '@renderer/store/user'
import { formatDateTime } from '@renderer/utils/date'
import { useSessionOperation } from '@renderer/composables/useSessionOperation'

const router = useRouter()
const route = useRoute()
const operations = useSessionOperation()
const i18nStore = useI18nStore()
const notebookStore = useNotebookStore()
const userStore = useUserStore()

const notebooks = ref<NotebookSummaryDTO[]>([])
const loading = ref(true)
const submitting = ref(false)

const createVisible = ref(false)
const createForm = reactive({ name: '', password: '', confirm: '' })

const unlockVisible = ref(false)
const unlockTarget = ref<NotebookSummaryDTO | null>(null)
const unlockPassword = ref('')

const importVisible = ref(false)
const importPassword = ref('')
const importing = ref(false)
const validImportPassword = computed(() => isValidNotebookPassword(importPassword.value))

function setImportVisible(visible: boolean) {
  if (importing.value) return
  importVisible.value = visible
  if (!visible) importPassword.value = ''
}

function openImport() {
  if (importing.value || submitting.value || createVisible.value || unlockVisible.value) return
  if (!operations.capture().isActive()) return
  importPassword.value = ''
  importVisible.value = true
}

async function submitImport() {
  if (importing.value || submitting.value || !importVisible.value) return
  const operation = operations.capture()
  if (!operation.isActive()) return
  if (!isValidNotebookPassword(importPassword.value)) {
    ElMessage.warning(i18nStore.t.backup.passwordInvalid)
    return
  }
  const password = importPassword.value
  importPassword.value = ''
  importing.value = true
  try {
    // The password is only used to decrypt the archive; file selection, new copy creation,
    // and unlocking are all handled by the main process.
    const response = await operation.call(() => window.api.importDiaryBackup({ password }))
    if (!operation.isActive() || !response) return
    if (!response.success) {
      const message =
        response.code === 'INVALID_NOTEBOOK_PASSWORD'
          ? i18nStore.t.backup.passwordWrong
          : response.code === 'INVALID_BACKUP'
            ? i18nStore.t.backup.invalidArchive
            : i18nStore.t.backup.importFail
      ElMessage.error(message)
      return
    }
    if (response.data?.canceled) return
    if (!response.data?.notebook) {
      ElMessage.error(i18nStore.t.backup.importFail)
      return
    }
    const notebook = response.data.notebook
    notebookStore.setCurrent(notebook)
    importVisible.value = false
    ElMessage.success(
      i18nStore.t.backup.importSuccess
        .replace('{count}', String(response.data.diaryCount ?? 0))
        .replace('{name}', () => notebook.name)
    )
    await router.push(`/notebooks/${notebook.id}/diaries`)
    if (!operation.isActive()) return
  } catch {
    if (operation.isActive()) ElMessage.error(i18nStore.t.backup.importFail)
  } finally {
    if (operation.isActive()) importing.value = false
  }
}

watch(
  () => [route.fullPath, userStore.sessionRevision],
  () => {
    importPassword.value = ''
  },
  { flush: 'sync' }
)
onBeforeUnmount(() => {
  importPassword.value = ''
})

async function load() {
  const operation = operations.capture()
  if (!operation.isActive()) return
  loading.value = true
  try {
    const res = await operation.call(() => window.api.listNotebooks())
    if (!operation.isActive() || !res) return
    if (!res.success) {
      ElMessage.error(res.message || i18nStore.t.notebook.loadFail)
      return
    }
    notebooks.value = res.data ?? []
    const requested = typeof route.query.unlock === 'string' ? Number(route.query.unlock) : NaN
    const target = notebooks.value.find((notebook) => notebook.id === requested)
    if (target) openNotebook(target)
  } catch {
    if (operation.isActive()) ElMessage.error(i18nStore.t.notebook.loadFail)
  } finally {
    if (operation.isActive()) loading.value = false
  }
}

function openCreate() {
  if (importing.value || importVisible.value) return
  if (!operations.capture().isActive()) return
  createForm.name = ''
  createForm.password = ''
  createForm.confirm = ''
  createVisible.value = true
}

async function submitCreate() {
  if (submitting.value || importing.value || importVisible.value) return
  if (!createForm.name.trim()) {
    ElMessage.warning(i18nStore.t.notebook.nameReq)
    return
  }
  if (!createForm.password) {
    ElMessage.warning(i18nStore.t.notebook.passReq)
    return
  }
  if (createForm.password !== createForm.confirm) {
    ElMessage.warning(i18nStore.t.notebook.passMatch)
    return
  }

  const operation = operations.capture()
  if (!operation.isActive()) return
  // Create the notebook, mark it unlocked, and enter its diary list.
  submitting.value = true
  try {
    const res = await operation.call(() =>
      window.api.createNotebook({
        name: createForm.name.trim(),
        password: createForm.password
      })
    )
    if (!operation.isActive() || !res) return
    if (!res.success || !res.data) {
      ElMessage.error(res.message || i18nStore.t.notebook.createFail)
      return
    }
    notebookStore.setCurrent(res.data)
    ElMessage.success(i18nStore.t.notebook.createSuccess)
    createVisible.value = false
    await router.push(`/notebooks/${res.data.id}/diaries`)
  } catch {
    if (operation.isActive()) ElMessage.error(i18nStore.t.notebook.createFail)
  } finally {
    if (operation.isActive()) submitting.value = false
  }
}

function openNotebook(notebook: NotebookSummaryDTO) {
  if (importing.value || importVisible.value) return
  if (!operations.capture().isActive()) return
  if (notebookStore.isUnlocked(notebook.id)) {
    notebookStore.setCurrent(notebook)
    router.push(`/notebooks/${notebook.id}/diaries`)
    return
  }
  unlockTarget.value = notebook
  unlockPassword.value = ''
  unlockVisible.value = true
}

async function submitUnlock() {
  if (submitting.value || importing.value || importVisible.value || !unlockTarget.value) return
  if (!unlockPassword.value) {
    ElMessage.warning(i18nStore.t.notebook.passReq)
    return
  }

  const operation = operations.capture()
  if (!operation.isActive()) return
  const target = unlockTarget.value
  // Unlock the notebook and enter its diary list.
  submitting.value = true
  try {
    const res = await operation.call(
      () =>
        window.api.unlockNotebook({
          notebookId: target.id,
          password: unlockPassword.value
        }),
      target.id
    )
    if (!operation.isActive() || !res) return
    if (!res.success || !res.data) {
      ElMessage.error(i18nStore.t.notebook.unlockFail)
      return
    }
    notebookStore.setCurrent(res.data)
    ElMessage.success(i18nStore.t.notebook.unlockSuccess)
    unlockVisible.value = false
    await router.push(`/notebooks/${res.data.id}/diaries`)
  } catch {
    if (operation.isActive()) ElMessage.error(i18nStore.t.notebook.unlockFail)
  } finally {
    if (operation.isActive()) submitting.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page-container">
    <header class="page-head max-w-[1040px]">
      <div>
        <h1 class="page-head-title">{{ i18nStore.t.notebook.title }}</h1>
        <p class="page-subtitle">{{ i18nStore.t.notebook.subtitle }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          class="btn-secondary import-button"
          data-testid="import-backup"
          :disabled="importing || submitting"
          @click="openImport"
        >
          {{ i18nStore.t.backup.import }}
        </button>
        <button
          type="button"
          class="btn-primary create-button"
          data-testid="create-notebook"
          :disabled="importing"
          @click="openCreate"
        >
          <span class="i-ep-plus" aria-hidden="true"></span>
          {{ i18nStore.t.notebook.create }}
        </button>
      </div>
    </header>

    <div v-if="loading" class="card-grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))]">
      <div v-for="n in 3" :key="n" class="app-surface notebook-card skeleton-card">
        <el-skeleton :rows="3" animated />
      </div>
    </div>

    <div v-else-if="notebooks.length === 0" class="empty-state max-w-[1040px]">
      <span class="empty-icon" aria-hidden="true"><span class="i-ep-notebook"></span></span>
      <p class="empty-title">{{ i18nStore.t.notebook.empty }}</p>
      <p class="empty-hint">{{ i18nStore.t.notebook.emptyHint }}</p>
    </div>

    <div v-else class="card-grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))]">
      <button
        v-for="notebook in notebooks"
        :key="notebook.id"
        type="button"
        class="app-surface notebook-card"
        data-testid="notebook-card"
        :disabled="importing"
        @click="openNotebook(notebook)"
      >
        <div
          class="mb-3 inline-flex h-[42px] w-[42px] items-center justify-center rounded-[13px] bg-brand-100 text-xl text-brand-700"
          aria-hidden="true"
        >
          <span class="i-ep-notebook"></span>
        </div>
        <h2 class="m-0 break-words text-base font-semibold tracking-[-0.01em]">
          {{ notebook.name }}
        </h2>
        <p class="mt-1.5 text-xs text-ink-soft">
          {{
            i18nStore.t.notebook.updatedAt.replace(
              '{time}',
              formatDateTime(notebook.updatedAt, i18nStore.locale)
            )
          }}
        </p>
        <span
          class="absolute bottom-[18px] right-[18px] text-base text-[#a5bbb9]"
          aria-hidden="true"
          ><span class="i-ep-arrow-right"></span
        ></span>
      </button>
    </div>

    <el-dialog
      :model-value="importVisible"
      :title="i18nStore.t.backup.importTitle"
      width="min(420px, 92vw)"
      append-to-body
      data-testid="import-backup-dialog"
      :show-close="!importing"
      :close-on-click-modal="!importing"
      :close-on-press-escape="!importing"
      @update:model-value="setImportVisible"
    >
      <p class="mb-[14px] text-[13px] text-ink-muted">{{ i18nStore.t.backup.importHint }}</p>
      <form class="custom-form" data-testid="import-backup-form" @submit.prevent="submitImport">
        <label class="block text-[13px]" for="backup-password">{{
          i18nStore.t.backup.password
        }}</label>
        <input
          id="backup-password"
          v-model="importPassword"
          type="password"
          autocomplete="off"
          class="backup-password-input"
          data-testid="backup-password"
          aria-describedby="backup-password-hint"
          :placeholder="i18nStore.t.backup.passwordPlaceholder"
          :disabled="importing"
        />
        <p id="backup-password-hint" class="mb-5 text-xs text-ink-muted">
          {{ i18nStore.t.backup.passwordHint }}
        </p>
        <div class="flex gap-2.5">
          <button
            type="button"
            class="btn-secondary"
            data-testid="cancel-import-backup"
            :disabled="importing"
            @click="setImportVisible(false)"
          >
            {{ i18nStore.t.close.cancel }}
          </button>
          <button
            type="submit"
            class="btn-primary"
            data-testid="submit-import-backup"
            :disabled="importing || submitting || !validImportPassword"
            :aria-busy="importing"
          >
            <span v-if="importing" class="i-ep-loading animate-spin" aria-hidden="true"></span>
            {{ importing ? i18nStore.t.backup.importing : i18nStore.t.backup.importSubmit }}
          </button>
        </div>
      </form>
    </el-dialog>

    <el-dialog
      v-model="createVisible"
      :title="i18nStore.t.notebook.createTitle"
      width="min(420px, 92vw)"
      append-to-body
    >
      <el-form label-position="top" class="custom-form" @submit.prevent="submitCreate">
        <el-form-item :label="i18nStore.t.notebook.name">
          <el-input
            v-model="createForm.name"
            maxlength="80"
            :placeholder="i18nStore.t.notebook.namePlaceholder"
          />
        </el-form-item>
        <el-form-item :label="i18nStore.t.notebook.password">
          <el-input
            v-model="createForm.password"
            type="password"
            show-password
            :placeholder="i18nStore.t.notebook.passwordPlaceholder"
          />
        </el-form-item>
        <el-form-item :label="i18nStore.t.notebook.confirmPassword">
          <el-input
            v-model="createForm.confirm"
            type="password"
            show-password
            :placeholder="i18nStore.t.notebook.confirmPasswordPlaceholder"
          />
        </el-form-item>
        <button type="submit" class="btn-primary" :disabled="submitting" :aria-busy="submitting">
          <span v-if="submitting" class="i-ep-loading animate-spin" aria-hidden="true"></span>
          {{ i18nStore.t.notebook.createSubmit }}
        </button>
      </el-form>
    </el-dialog>

    <el-dialog
      v-model="unlockVisible"
      :title="i18nStore.t.notebook.unlockTitle"
      width="min(400px, 92vw)"
      append-to-body
    >
      <p class="mb-[14px] text-[13px] text-ink-muted">{{ i18nStore.t.notebook.unlockPrompt }}</p>
      <el-form label-position="top" class="custom-form" @submit.prevent="submitUnlock">
        <el-form-item :label="i18nStore.t.notebook.password">
          <el-input
            v-model="unlockPassword"
            type="password"
            show-password
            :placeholder="i18nStore.t.notebook.passwordPlaceholder"
          />
        </el-form-item>
        <button type="submit" class="btn-primary" :disabled="submitting" :aria-busy="submitting">
          <span v-if="submitting" class="i-ep-loading animate-spin" aria-hidden="true"></span>
          {{ i18nStore.t.notebook.unlockSubmit }}
        </button>
      </el-form>
    </el-dialog>
  </div>
</template>

<style scoped>
/* Cover the width/height of  btn-primary , used only on this page */
.create-button,
.import-button {
  width: auto;
  min-height: 42px;
  padding: 0 18px;
}

.backup-password-input {
  width: 100%;
  margin: 8px 0;
  padding: 10px 12px;
  border: 1px solid currentColor;
  border-radius: 8px;
  background: transparent;
}

.notebook-card {
  position: relative;
  display: flex;
  min-height: 150px;
  flex-direction: column;
  align-items: flex-start;
  padding: 22px;
  border-radius: 18px;
  text-align: left;
  cursor: pointer;
  transition:
    transform 0.16s ease,
    box-shadow 0.16s ease;
}

button.notebook-card {
  border: 1px solid rgb(255 255 255 / 90%);
}

.notebook-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 20px 50px -28px rgb(42 83 101 / 35%);
}

.skeleton-card {
  cursor: default;
}
</style>
