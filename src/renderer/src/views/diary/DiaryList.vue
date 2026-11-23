<script setup lang="ts">
import { DIARY_PAGE_SIZE_DEFAULT, DIARY_PAGE_SIZE_MAX, type DiarySummaryDTO } from '@common/diary'
import { useI18nStore } from '@renderer/store/i18n'
import { useNotebookStore } from '@renderer/store/notebook'
import { formatDateTime } from '@renderer/utils/date'
import { useSessionOperation } from '@renderer/composables/useSessionOperation'

const props = defineProps<{ notebookId: string }>()

const router = useRouter()
const operations = useSessionOperation()
const i18nStore = useI18nStore()
const notebookStore = useNotebookStore()

const notebookId = computed(() => Number(props.notebookId))
const notebookName = computed(() => notebookStore.current?.name ?? '')

const diaries = ref<DiarySummaryDTO[]>([])
const loading = ref(true)
const locking = ref(false)
const page = ref(1)
const pageSize = ref(DIARY_PAGE_SIZE_DEFAULT)
const pageSizeInput = ref<number | string>(DIARY_PAGE_SIZE_DEFAULT)
const total = ref(0)
const hasLoaded = ref(false)
const loadFailed = ref(false)
const pages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))
const validPageSize = computed(
  () =>
    typeof pageSizeInput.value === 'number' &&
    Number.isSafeInteger(pageSizeInput.value) &&
    pageSizeInput.value >= 1 &&
    pageSizeInput.value <= DIARY_PAGE_SIZE_MAX
)
let requestSequence = 0
let retryPage = 1
let retryPageSize = DIARY_PAGE_SIZE_DEFAULT

async function load(targetPage = page.value, targetPageSize = pageSize.value) {
  const operation = operations.capture()
  if (!operation.isActive() || locking.value) return
  const request = ++requestSequence
  const isCurrent = () => operation.isActive() && request === requestSequence
  const id = notebookId.value
  retryPage = targetPage
  retryPageSize = targetPageSize
  loading.value = true
  loadFailed.value = false
  try {
    // Load one page, guarding against stale or out-of-order responses.
    const res = await operation.call(
      () => window.api.listDiaryPage(id, { page: targetPage, pageSize: targetPageSize }),
      id
    )
    if (!isCurrent() || !res) return
    if (!res.success || !res.data) {
      loadFailed.value = true
      ElMessage.error(res.message || i18nStore.t.diary.loadFail)
      return
    }
    diaries.value = res.data.items
    total.value = res.data.total
    page.value = res.data.page
    pageSize.value = res.data.pageSize
    hasLoaded.value = true
  } catch {
    if (isCurrent()) {
      loadFailed.value = true
      ElMessage.error(i18nStore.t.diary.loadFail)
    }
  } finally {
    if (isCurrent()) loading.value = false
  }
}

function applyPageSize() {
  if (!validPageSize.value) return
  void load(1, Number(pageSizeInput.value))
}

function retryLoad() {
  void load(retryPage, retryPageSize)
}

function openDiary(diary: DiarySummaryDTO) {
  if (!operations.capture().isActive()) return
  router.push(`/notebooks/${notebookId.value}/diaries/${diary.id}`)
}

function goNew() {
  if (!operations.capture().isActive()) return
  router.push(`/notebooks/${notebookId.value}/diaries/new`)
}

async function handleLock() {
  if (locking.value) return
  const operation = operations.capture()
  if (!operation.isActive()) return
  const id = notebookId.value
  locking.value = true
  try {
    const response = await operation.call(() => window.api.lockNotebook(id), id)
    if (!operation.isActive() || !response) return
    if (!response.success) {
      ElMessage.error(response.message || i18nStore.t.notebook.lockFail)
      return
    }
    // Invalidate any in-flight page loads, clear the list, and return to notebooks.
    requestSequence++
    notebookStore.lockNotebook(id)
    diaries.value = []
    total.value = 0
    page.value = 1
    hasLoaded.value = false
    loadFailed.value = false
    ElMessage.success(i18nStore.t.notebook.lockSuccess)
    await router.push('/notebooks')
  } catch {
    if (operation.isActive()) ElMessage.error(i18nStore.t.notebook.lockFail)
  } finally {
    if (operation.isActive()) locking.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page-container">
    <header class="page-head max-w-[1040px]">
      <div>
        <button type="button" class="back-link" @click="router.push('/notebooks')">
          <span class="i-ep-arrow-left" aria-hidden="true"></span>
          {{ i18nStore.t.diary.back }}
        </button>
        <p class="eyebrow mt-3">{{ i18nStore.t.diary.listTitle }}</p>
        <h1 class="page-head-title break-words">{{ notebookName }}</h1>
      </div>
      <div class="flex items-center gap-2.5">
        <button
          type="button"
          class="btn-secondary lock-button"
          :disabled="locking"
          @click="handleLock"
        >
          <span class="i-ep-lock" aria-hidden="true"></span>
          {{ i18nStore.t.notebook.lock }}
        </button>
        <button type="button" class="btn-primary create-button" @click="goNew">
          <span class="i-ep-edit-pen" aria-hidden="true"></span>
          {{ i18nStore.t.diary.create }}
        </button>
      </div>
    </header>

    <section class="pagination-controls max-w-[1040px]" :aria-label="i18nStore.t.diary.pageSize">
      <label class="flex items-center gap-2">
        {{ i18nStore.t.diary.pageSize }}
        <input
          v-model.number="pageSizeInput"
          type="number"
          min="1"
          :max="DIARY_PAGE_SIZE_MAX"
          step="1"
          class="page-size-input"
          data-testid="page-size"
          :aria-label="i18nStore.t.diary.pageSize"
          :title="i18nStore.t.diary.pageSizeHint"
          @keydown.enter.prevent="applyPageSize"
        />
      </label>
      <button
        type="button"
        class="btn-secondary page-control"
        data-testid="apply-page-size"
        :disabled="!validPageSize || locking"
        @click="applyPageSize"
      >
        {{ i18nStore.t.diary.applyPageSize }}
      </button>
      <span class="text-xs text-ink-muted">{{ i18nStore.t.diary.pageSizeHint }}</span>
      <template v-if="hasLoaded">
        <span data-testid="diary-total">
          {{ i18nStore.t.diary.totalCount.replace('{count}', String(total)) }}
        </span>
        <span data-testid="page-status">
          {{
            i18nStore.t.diary.pageStatus
              .replace('{page}', String(page))
              .replace('{pages}', String(pages))
          }}
        </span>
        <button
          type="button"
          class="btn-secondary page-control"
          data-testid="previous-page"
          :disabled="page <= 1 || locking"
          @click="load(page - 1)"
        >
          {{ i18nStore.t.diary.previousPage }}
        </button>
        <button
          type="button"
          class="btn-secondary page-control"
          data-testid="next-page"
          :disabled="page >= pages || locking"
          @click="load(page + 1)"
        >
          {{ i18nStore.t.diary.nextPage }}
        </button>
      </template>
    </section>

    <div v-if="loadFailed" class="mb-5 flex items-center gap-3" role="alert">
      <p>{{ i18nStore.t.diary.loadFail }}</p>
      <button
        type="button"
        class="btn-secondary page-control"
        data-testid="retry-page"
        @click="retryLoad"
      >
        {{ i18nStore.t.photowall.retry }}
      </button>
    </div>

    <div v-if="loading" class="card-grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))]">
      <div v-for="n in 4" :key="n" class="app-surface diary-card skeleton-card">
        <el-skeleton :rows="4" animated />
      </div>
    </div>

    <div v-else-if="hasLoaded && diaries.length === 0" class="empty-state max-w-[1040px]">
      <span class="empty-icon" aria-hidden="true"><span class="i-ep-tickets"></span></span>
      <p class="empty-title">{{ i18nStore.t.diary.empty }}</p>
      <p class="empty-hint">{{ i18nStore.t.diary.emptyHint }}</p>
    </div>

    <div v-else class="card-grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))]">
      <button
        v-for="diary in diaries"
        :key="diary.id"
        type="button"
        class="app-surface diary-card"
        data-testid="diary-card"
        @click="openDiary(diary)"
      >
        <time class="text-xs font-semibold text-accent-600">
          {{ formatDateTime(diary.occurredAt, i18nStore.locale) }}
        </time>
        <h2 class="mt-2.5 break-words text-[17px] font-semibold tracking-[-0.01em]">
          {{ diary.title || i18nStore.t.diary.untitled }}
        </h2>
        <p class="mt-2 line-clamp-3 text-[13px] leading-[1.6] text-ink-muted">
          {{ diary.preview || '' }}
        </p>
      </button>
    </div>
  </div>
</template>

<style scoped>
.pagination-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
}

.page-size-input {
  width: 76px;
  padding: 8px;
  border: 1px solid currentColor;
  border-radius: 8px;
  background: transparent;
}

.page-control {
  width: auto;
  min-height: 36px;
  padding: 0 12px;
}

/* Covers the width/height of btn-*, used only on list pages. */
.lock-button {
  width: auto;
  min-height: 42px;
  padding: 0 16px;
}

.create-button {
  width: auto;
  min-height: 42px;
  padding: 0 18px;
}

.diary-card {
  display: flex;
  min-height: 170px;
  flex-direction: column;
  align-items: flex-start;
  padding: 20px;
  border-radius: 18px;
  text-align: left;
  cursor: pointer;
  transition:
    transform 0.16s ease,
    box-shadow 0.16s ease;
}

button.diary-card {
  border: 1px solid rgb(255 255 255 / 90%);
}

.diary-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 20px 50px -28px rgb(42 83 101 / 35%);
}

.skeleton-card {
  cursor: default;
}
</style>
