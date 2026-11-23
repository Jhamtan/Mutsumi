<script setup lang="ts">
import type { DiaryDTO } from '@common/types'
import { useI18nStore } from '@renderer/store/i18n'
import { formatDateTime } from '@renderer/utils/date'
import { renderMarkdown } from '@renderer/utils/markdown'
import { useSessionOperation } from '@renderer/composables/useSessionOperation'

const props = defineProps<{ notebookId: string; diaryId: string }>()

const router = useRouter()
const operations = useSessionOperation()
const i18nStore = useI18nStore()

const notebookId = computed(() => Number(props.notebookId))
const diaryId = computed(() => Number(props.diaryId))

const diary = ref<DiaryDTO | null>(null)
const loading = ref(true)
const notFound = ref(false)
const deleteVisible = ref(false)
const deleting = ref(false)

const contentHtml = computed(() => {
  if (!diary.value) return ''
  const imageMap = new Map(diary.value.images.map((image) => [image.reference, image.dataUrl]))
  return renderMarkdown(diary.value.markdown, (reference) => imageMap.get(reference))
})

async function load() {
  const operation = operations.capture()
  if (!operation.isActive()) return
  const id = notebookId.value
  loading.value = true
  try {
    const res = await operation.call(() => window.api.getDiary(id, diaryId.value), id)
    if (!operation.isActive() || !res) return
    if (!res.success || !res.data) {
      notFound.value = true
      return
    }
    diary.value = res.data
  } catch {
    if (operation.isActive()) notFound.value = true
  } finally {
    if (operation.isActive()) loading.value = false
  }
}

function goEdit() {
  if (!operations.capture().isActive()) return
  router.push(`/notebooks/${notebookId.value}/diaries/${diaryId.value}/edit`)
}

function openDelete() {
  if (!operations.capture().isActive()) return
  deleteVisible.value = true
}

async function confirmDelete() {
  if (deleting.value) return
  const operation = operations.capture()
  if (!operation.isActive()) return
  const id = notebookId.value
  deleting.value = true
  try {
    const res = await operation.call(() => window.api.deleteDiary(id, diaryId.value), id)
    if (!operation.isActive() || !res) return
    if (!res.success) {
      ElMessage.error(res.message || i18nStore.t.diary.deleteFail)
      return
    }
    ElMessage.success(i18nStore.t.diary.deleteSuccess)
    deleteVisible.value = false
    await router.push(`/notebooks/${notebookId.value}/diaries`)
  } catch {
    if (operation.isActive()) ElMessage.error(i18nStore.t.diary.deleteFail)
  } finally {
    if (operation.isActive()) deleting.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page-container">
    <header class="mx-auto mb-5 flex max-w-[860px] items-center justify-between gap-4">
      <button
        type="button"
        class="back-link"
        @click="router.push(`/notebooks/${notebookId}/diaries`)"
      >
        <span class="i-ep-arrow-left" aria-hidden="true"></span>
        {{ i18nStore.t.diary.back }}
      </button>
      <div v-if="diary" class="flex gap-2.5">
        <button type="button" class="btn-secondary action-button" @click="goEdit">
          <span class="i-ep-edit" aria-hidden="true"></span>
          {{ i18nStore.t.diary.editTitle }}
        </button>
        <button type="button" class="delete-button action-button" @click="openDelete">
          <span class="i-ep-delete" aria-hidden="true"></span>
          {{ i18nStore.t.diary.delete }}
        </button>
      </div>
    </header>

    <div v-if="loading" class="app-surface mx-auto max-w-[860px] rounded-[22px] px-12 py-10">
      <el-skeleton :rows="8" animated />
    </div>

    <div v-else-if="notFound || !diary" class="empty-state max-w-[860px]">
      <span class="empty-icon" aria-hidden="true"><span class="i-ep-warning"></span></span>
      <p class="empty-title">{{ i18nStore.t.diary.notFound }}</p>
    </div>

    <article v-else class="app-surface mx-auto max-w-[860px] rounded-[22px] px-12 py-10">
      <time class="mb-5 block text-[13px] font-semibold text-accent-600">
        {{ formatDateTime(diary.occurredAt, i18nStore.locale) }}
      </time>
      <div
        class="markdown-body break-words text-[15px] leading-[1.8] text-ink"
        v-html="contentHtml"
      ></div>
    </article>

    <el-dialog
      v-model="deleteVisible"
      :title="i18nStore.t.diary.deleteTitle"
      width="min(380px, 92vw)"
      append-to-body
    >
      <p class="mb-5 text-[13px] leading-[1.7] text-ink-muted">
        {{ i18nStore.t.diary.deleteConfirm }}
      </p>
      <div class="flex justify-end gap-3">
        <button type="button" class="btn-secondary dialog-button" @click="deleteVisible = false">
          {{ i18nStore.t.diary.back }}
        </button>
        <button
          type="button"
          class="delete-button dialog-button"
          :disabled="deleting"
          @click="confirmDelete"
        >
          {{ i18nStore.t.diary.delete }}
        </button>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
/* Covers the width/height of BTN-*, used only on detail page */
.action-button {
  width: auto;
  min-height: 40px;
  padding: 0 16px;
}

.delete-button {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: 1px solid #f2d5d8;
  border-radius: 12px;
  background: #fdf3f4;
  color: #bf4d59;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.16s ease;
}

.delete-button:hover {
  background: #fbe8ea;
}

.dialog-button {
  width: auto;
  min-height: 40px;
  padding: 0 18px;
}

.dialog-button.btn-secondary {
  border-radius: 12px;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3) {
  margin: 1.3em 0 0.55em;
  line-height: 1.3;
}

.markdown-body :deep(h1:first-child),
.markdown-body :deep(h2:first-child),
.markdown-body :deep(h3:first-child),
.markdown-body :deep(p:first-child) {
  margin-top: 0;
}

.markdown-body :deep(h1) {
  padding-bottom: 0.35em;
  border-bottom: 1px solid #e8f1f0;
  font-size: 1.7em;
}

.markdown-body :deep(p),
.markdown-body :deep(ul),
.markdown-body :deep(ol),
.markdown-body :deep(blockquote),
.markdown-body :deep(pre),
.markdown-body :deep(table) {
  margin: 0.8em 0;
}

.markdown-body :deep(blockquote) {
  padding: 0.2em 1em;
  border-left: 4px solid #6dc29c;
  color: #607780;
}

.markdown-body :deep(code) {
  padding: 0.15em 0.4em;
  border-radius: 5px;
  background: #edf7f3;
  font-family: 'Cascadia Code', 'SFMono-Regular', Consolas, monospace;
  font-size: 0.9em;
}

.markdown-body :deep(pre) {
  overflow: auto;
  padding: 14px;
  border-radius: 10px;
  background: #edf7f3;
}

.markdown-body :deep(pre code) {
  padding: 0;
  background: transparent;
}

.markdown-body :deep(table) {
  width: 100%;
  border-collapse: collapse;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  padding: 7px 9px;
  border: 1px solid #dcebea;
  text-align: left;
}

.markdown-body :deep(img) {
  display: block;
  max-width: 100%;
  max-height: 560px;
  margin: 1em auto;
  border-radius: 10px;
  object-fit: contain;
}
</style>
