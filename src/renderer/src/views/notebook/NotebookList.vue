<script setup lang="ts">
import type { NotebookSummaryDTO } from '@common/types'
import { useI18nStore } from '@renderer/store/i18n'
import { useNotebookStore } from '@renderer/store/notebook'
import { formatDateTime } from '@renderer/utils/date'
import { useSessionOperation } from '@renderer/composables/useSessionOperation'

const router = useRouter()
const route = useRoute()
const operations = useSessionOperation()
const i18nStore = useI18nStore()
const notebookStore = useNotebookStore()

const notebooks = ref<NotebookSummaryDTO[]>([])
const loading = ref(true)
const submitting = ref(false)

const createVisible = ref(false)
const createForm = reactive({ name: '', password: '', confirm: '' })

const unlockVisible = ref(false)
const unlockTarget = ref<NotebookSummaryDTO | null>(null)
const unlockPassword = ref('')

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
  if (!operations.capture().isActive()) return
  createForm.name = ''
  createForm.password = ''
  createForm.confirm = ''
  createVisible.value = true
}

async function submitCreate() {
  if (submitting.value) return
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
  if (submitting.value || !unlockTarget.value) return
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
      <button type="button" class="btn-primary create-button" @click="openCreate">
        <span class="i-ep-plus" aria-hidden="true"></span>
        {{ i18nStore.t.notebook.create }}
      </button>
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
.create-button {
  width: auto;
  min-height: 42px;
  padding: 0 18px;
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
