<script setup lang="ts">
import type { DiaryImageDTO } from '@common/types'
import MarkdownEditor from '@renderer/components/MarkdownEditor.vue'
import { useI18nStore } from '@renderer/store/i18n'
import { collectDraftImages } from '@renderer/utils/draft-image-storage'
import { clearDraft, loadDraft, saveDraft } from '@renderer/utils/draft-storage'
import { useSessionOperation } from '@renderer/composables/useSessionOperation'
import { useUserStore } from '@renderer/store/user'
import { useNotebookStore } from '@renderer/store/notebook'

interface DiaryDraft {
  version: 1
  markdown: string
  occurredAt: string | null
  diaryId: number | null
}

type DraftStatus = 'idle' | 'pending' | 'saved' | 'restored' | 'error' | 'invalid'

const props = defineProps<{ notebookId: string; diaryId?: string }>()
const router = useRouter()
const operations = useSessionOperation()
const userStore = useUserStore()
const notebookStore = useNotebookStore()
const i18nStore = useI18nStore()
const ownerSession = userStore.captureSession()
const ownerOperation = operations.capture()
const ownerNotebook = props.notebookId
const ownerDiary = props.diaryId
const ownerNotebookId = Number(ownerNotebook)
const initialDiaryId = ownerDiary ? Number(ownerDiary) : null
const savedDiaryId = ref<number | null>(initialDiaryId)
const isEdit = computed(() => savedDiaryId.value !== null)
// Keep the namespace fixed to the page owner, even while another account signs in.
const diaryScope = ownerDiary
  ? `diary:${ownerNotebook}:${ownerDiary}`
  : `diary:new:${ownerNotebook}`
const imageStorageKey = `user:${ownerSession.userId ?? 'anonymous'}:${diaryScope}`

const occurredAt = ref<Date | null>(new Date())
const markdown = ref('')
const persistentImages = ref<DiaryImageDTO[]>([])
const loading = ref(isEdit.value)
const saving = ref(false)
const discarding = ref(false)
const notFound = ref(false)
const hasBodyDraft = ref(false)
const draftDirty = ref(false)
const draftStatus = ref<DraftStatus>('idle')
let draftReady = false
let warnedAboutStorage = false
let savedMarkdown = ''
let savedOccurredAt: Date | null = new Date(occurredAt.value!)

function scopeUnchanged(): boolean {
  return props.notebookId === ownerNotebook && props.diaryId === ownerDiary
}

function activePage(): boolean {
  return scopeUnchanged() && ownerOperation.isActive()
}

function ownsDraft(): boolean {
  return (
    scopeUnchanged() &&
    ownerSession.userId !== null &&
    userStore.matchesSession(ownerSession) &&
    notebookStore.isUnlocked(ownerNotebookId)
  )
}

const canUseDraft = computed(() => ownsDraft() && activePage())
const draftStatusText = computed(() => {
  const text = i18nStore.t.diary
  switch (draftStatus.value) {
    case 'pending':
      return text.draftPending
    case 'saved':
      return text.draftSaved
    case 'restored':
      return text.draftRestored
    case 'error':
      return text.draftSaveFail
    case 'invalid':
      return text.draftInvalid
    default:
      return ''
  }
})

/** The existing helper accepts strings; an envelope preserves empty text and time. */
function readBodyDraft(): DiaryDraft | undefined {
  if (!ownsDraft() || !activePage()) return undefined
  const raw = loadDraft(imageStorageKey)
  if (!raw) return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    value = undefined
  }
  if (value && typeof value === 'object' && 'version' in value) {
    const record = value as Record<string, unknown>
    const id = record.diaryId
    const time = record.occurredAt
    if (
      record.version !== 1 ||
      typeof record.markdown !== 'string' ||
      !(id === null || (typeof id === 'number' && Number.isSafeInteger(id) && id > 0)) ||
      !(time === null || (typeof time === 'string' && Number.isFinite(new Date(time).getTime()))) ||
      (initialDiaryId !== null && id !== initialDiaryId)
    ) {
      hasBodyDraft.value = true
      draftStatus.value = 'invalid'
      return undefined
    }
    return { version: 1, markdown: record.markdown, occurredAt: time, diaryId: id }
  }
  // Preserve compatibility with plain Markdown written through the original helper.
  return {
    version: 1,
    markdown: raw,
    occurredAt: occurredAt.value!.toISOString(),
    diaryId: initialDiaryId
  }
}

function persistBodyDraft(leaving = false): void {
  if (!draftReady || !draftDirty.value || !ownsDraft() || (!leaving && !activePage())) return
  const date = occurredAt.value
  const record: DiaryDraft = {
    version: 1,
    markdown: markdown.value,
    occurredAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : null,
    diaryId: savedDiaryId.value
  }
  if (saveDraft(imageStorageKey, JSON.stringify(record))) {
    draftDirty.value = false
    hasBodyDraft.value = true
    draftStatus.value = 'saved'
  } else {
    draftStatus.value = 'error'
    if (!warnedAboutStorage && !leaving) {
      warnedAboutStorage = true
      ElMessage.warning(i18nStore.t.diary.draftSaveFail)
    }
  }
}

function handleDraftSave(value: string): void {
  if (value === markdown.value) persistBodyDraft()
}

watch(
  [markdown, occurredAt],
  () => {
    if (!draftReady || !ownsDraft() || !activePage()) return
    draftDirty.value = true
    draftStatus.value = 'pending'
  },
  { flush: 'sync' }
)
// A time-only edit does not emit the Markdown component's debounced save event.
watch(occurredAt, () => persistBodyDraft(), { flush: 'post' })

/** Resolve already-persisted `diary-image://` references during edit. */
function resolvePersistentImage(reference: string): string | undefined {
  return persistentImages.value.find((image) => image.reference === reference)?.dataUrl
}

async function load() {
  const operation = operations.capture()
  if (!operation.isActive() || !activePage()) return
  const draft = readBodyDraft()
  if (initialDiaryId === null && draft?.diaryId) savedDiaryId.value = draft.diaryId
  try {
    if (savedDiaryId.value !== null) {
      loading.value = true
      const res = await operation.call(
        () => window.api.getDiary(ownerNotebookId, savedDiaryId.value!),
        ownerNotebookId
      )
      if (!operation.isActive() || !activePage() || !res) return
      if (!res.success || !res.data) {
        notFound.value = true
        return
      }
      markdown.value = res.data.markdown
      occurredAt.value = new Date(res.data.occurredAt)
      persistentImages.value = res.data.images
    }
    savedMarkdown = markdown.value
    savedOccurredAt = occurredAt.value ? new Date(occurredAt.value) : null
    // Apply cached text only after the saved entry and its image resolver are ready.
    if (draft && ownsDraft() && activePage()) {
      markdown.value = draft.markdown
      occurredAt.value = draft.occurredAt ? new Date(draft.occurredAt) : null
      hasBodyDraft.value = true
      draftStatus.value = 'restored'
    }
    draftReady = true
  } catch {
    if (operation.isActive() && activePage()) notFound.value = true
  } finally {
    if (operation.isActive() && activePage()) loading.value = false
  }
}

async function handleSave() {
  if (saving.value || discarding.value || !activePage()) return
  const date = occurredAt.value
  if (!date || !Number.isFinite(date.getTime())) {
    ElMessage.warning(i18nStore.t.diary.timeReq)
    return
  }
  const operation = operations.capture()
  if (!operation.isActive()) return
  persistBodyDraft()
  saving.value = true
  try {
    const submittedMarkdown = markdown.value
    const submittedTime = date.toISOString()
    const images = collectDraftImages(imageStorageKey, submittedMarkdown)
    const payload = {
      notebookId: ownerNotebookId,
      occurredAt: submittedTime,
      markdown: submittedMarkdown,
      images
    }
    const id = savedDiaryId.value
    const res = await operation.call(
      () =>
        id !== null
          ? window.api.updateDiary({ ...payload, diaryId: id })
          : window.api.createDiary(payload),
      ownerNotebookId
    )
    if (!operation.isActive() || !activePage() || !res) return
    if (!res.success || !res.data || !Number.isSafeInteger(res.data.id) || res.data.id <= 0) {
      ElMessage.error(res.message || i18nStore.t.diary.saveFail)
      return
    }
    savedDiaryId.value = res.data.id
    savedMarkdown = res.data.markdown
    savedOccurredAt = new Date(res.data.occurredAt)
    persistentImages.value = res.data.images
    const currentTime =
      occurredAt.value && Number.isFinite(occurredAt.value.getTime())
        ? occurredAt.value.toISOString()
        : null
    if (markdown.value !== submittedMarkdown || currentTime !== submittedTime) {
      // Never delete newer edits or their images because an older save completed.
      draftDirty.value = true
      persistBodyDraft()
      ElMessage.warning(i18nStore.t.diary.draftNewChanges)
      return
    }
    draftReady = false
    markdown.value = res.data.markdown
    occurredAt.value = new Date(res.data.occurredAt)
    draftDirty.value = false
    hasBodyDraft.value = false
    draftStatus.value = 'idle'
    if (!clearDraft(imageStorageKey)) ElMessage.warning(i18nStore.t.diary.draftClearFail)
    draftReady = true
    ElMessage.success(i18nStore.t.diary.saveSuccess)
    await router.replace(`/notebooks/${ownerNotebookId}/diaries/${res.data.id}`)
  } catch {
    if (operation.isActive() && activePage()) ElMessage.error(i18nStore.t.diary.saveFail)
  } finally {
    if (operation.isActive() && activePage()) saving.value = false
  }
}

async function discardBodyDraft() {
  if (saving.value || discarding.value || !canUseDraft.value) return
  const operation = operations.capture()
  discarding.value = true
  try {
    await ElMessageBox.confirm(
      i18nStore.t.diary.draftDiscardConfirm,
      i18nStore.t.diary.draftDiscardTitle,
      {
        confirmButtonText: i18nStore.t.diary.draftDiscard,
        cancelButtonText: i18nStore.t.close.cancel,
        type: 'warning'
      }
    )
    if (!operation.isActive() || !activePage() || !ownsDraft()) return
    if (!clearDraft(imageStorageKey)) {
      ElMessage.warning(i18nStore.t.diary.draftClearFail)
      return
    }
    draftReady = false
    markdown.value = savedMarkdown
    occurredAt.value = savedOccurredAt ? new Date(savedOccurredAt) : null
    draftDirty.value = false
    hasBodyDraft.value = false
    draftStatus.value = 'idle'
    draftReady = true
    ElMessage.success(i18nStore.t.diary.draftDiscardSuccess)
  } catch {
    // Cancelling the confirmation keeps the draft and its images untouched.
  } finally {
    if (operation.isActive()) discarding.value = false
  }
}

function handleCancel() {
  if (saving.value || discarding.value || !activePage()) return
  persistBodyDraft()
  const target =
    savedDiaryId.value !== null
      ? `/notebooks/${ownerNotebookId}/diaries/${savedDiaryId.value}`
      : `/notebooks/${ownerNotebookId}/diaries`
  void router.push(target)
}

function flushDraftBeforeUnload(): void {
  persistBodyDraft(true)
}
onMounted(() => {
  window.addEventListener('beforeunload', flushDraftBeforeUnload)
  void load()
})
onBeforeUnmount(() => {
  // The operation composable already invalidated this page; flush only its fixed
  // namespace while the same account still owns an unlocked notebook.
  persistBodyDraft(true)
  window.removeEventListener('beforeunload', flushDraftBeforeUnload)
})
</script>

<template>
  <div class="page-container">
    <header class="mx-auto mb-5 flex max-w-[900px] items-center gap-4">
      <button
        type="button"
        class="back-link"
        :disabled="saving || discarding"
        @click="handleCancel"
      >
        <span class="i-ep-arrow-left" aria-hidden="true"></span>
        {{ i18nStore.t.diary.back }}
      </button>
      <h1 class="text-[22px] font-semibold tracking-[-0.03em]">
        {{ isEdit ? i18nStore.t.diary.editTitle : i18nStore.t.diary.newTitle }}
      </h1>
    </header>

    <div v-if="loading" class="editor-card">
      <el-skeleton :rows="8" animated />
    </div>

    <div v-else-if="notFound" class="empty-state max-w-[900px]">
      <span class="empty-icon" aria-hidden="true"><span class="i-ep-warning"></span></span>
      <p class="empty-title">{{ i18nStore.t.diary.notFound }}</p>
    </div>

    <div v-else class="editor-card">
      <fieldset class="editor-fields" :disabled="saving || discarding">
        <div class="mb-[18px] flex flex-col gap-2">
          <label class="text-xs font-semibold text-ink" for="diary-occurred-at">{{
            i18nStore.t.diary.time
          }}</label>
          <el-date-picker
            id="diary-occurred-at"
            v-model="occurredAt"
            type="datetime"
            format="YYYY-MM-DD HH:mm"
            :placeholder="i18nStore.t.diary.timePlaceholder"
            data-testid="time-picker"
          />
        </div>

        <label class="mb-2 block text-xs font-semibold text-ink">{{
          i18nStore.t.diary.content
        }}</label>
        <MarkdownEditor
          v-model="markdown"
          :labels="i18nStore.t.diary.editor"
          :image-storage-key="imageStorageKey"
          :resolve-persistent-image="resolvePersistentImage"
          :placeholder="i18nStore.t.diary.untitled"
          height="min(58vh, 560px)"
          @save="handleDraftSave"
        />
      </fieldset>

      <div v-if="canUseDraft" class="draft-controls">
        <div class="text-xs leading-relaxed text-ink-muted">
          <p class="m-0">{{ i18nStore.t.diary.draftHint }}</p>
          <p
            v-if="draftStatusText"
            class="mb-0 mt-1"
            :role="draftStatus === 'error' || draftStatus === 'invalid' ? 'alert' : 'status'"
            aria-live="polite"
            data-testid="draft-status"
          >
            {{ draftStatusText }}
          </p>
        </div>
        <button
          type="button"
          class="btn-secondary action-button"
          data-testid="discard-draft"
          :disabled="saving || discarding || !(hasBodyDraft || draftDirty)"
          @click="discardBodyDraft"
        >
          {{ i18nStore.t.diary.draftDiscard }}
        </button>
      </div>

      <div class="mt-5 flex justify-end gap-3">
        <button
          type="button"
          class="btn-secondary action-button"
          data-testid="cancel-button"
          :disabled="saving || discarding"
          @click="handleCancel"
        >
          {{ i18nStore.t.diary.back }}
        </button>
        <button
          type="button"
          class="btn-primary action-button"
          :disabled="saving || discarding"
          :aria-busy="saving"
          data-testid="save-button"
          @click="handleSave"
        >
          <span v-if="saving" class="i-ep-loading animate-spin" aria-hidden="true"></span>
          {{ saving ? i18nStore.t.diary.saving : i18nStore.t.diary.save }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.editor-fields {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.draft-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 16px;
}

.editor-card {
  max-width: 900px;
  margin: 0 auto;
  padding: 24px;
  border: 1px solid rgb(255 255 255 / 90%);
  border-radius: 20px;
  background: rgb(255 255 255 / 72%);
  box-shadow: 0 24px 80px -28px rgb(42 83 101 / 22%);
}

/* Covers the width/height of btn-*, used only in edit pages. */
.action-button {
  width: auto;
  min-height: 42px;
  padding: 0 22px;
}
</style>
