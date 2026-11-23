<script setup lang="ts">
import type { DiaryImageDTO } from '@common/types'
import MarkdownEditor from '@renderer/components/MarkdownEditor.vue'
import { useI18nStore } from '@renderer/store/i18n'
import { clearDraftImages, collectDraftImages } from '@renderer/utils/draft-image-storage'
import { useSessionOperation } from '@renderer/composables/useSessionOperation'
import { useUserStore } from '@renderer/store/user'

const props = defineProps<{ notebookId: string; diaryId?: string }>()

const router = useRouter()
const operations = useSessionOperation()
const userStore = useUserStore()
const i18nStore = useI18nStore()

const notebookId = computed(() => Number(props.notebookId))
const isEdit = computed(() => Boolean(props.diaryId))
const imageStorageKey = computed(() => {
  const user = userStore.currentUser?.id ?? 'anonymous'
  const diary = props.diaryId
    ? `diary:${props.notebookId}:${props.diaryId}`
    : `diary:new:${props.notebookId}`
  return `user:${user}:${diary}`
})

const occurredAt = ref<Date>(new Date())
const markdown = ref('')
const persistentImages = ref<DiaryImageDTO[]>([])
const loading = ref(false)
const saving = ref(false)
const notFound = ref(false)

/** Resolve already-persisted `diary-image://` references during edit. */
function resolvePersistentImage(reference: string): string | undefined {
  return persistentImages.value.find((image) => image.reference === reference)?.dataUrl
}

async function load() {
  if (!isEdit.value) return
  const operation = operations.capture()
  if (!operation.isActive()) return
  const id = notebookId.value
  loading.value = true
  try {
    const res = await operation.call(() => window.api.getDiary(id, Number(props.diaryId)), id)
    if (!operation.isActive() || !res) return
    if (!res.success || !res.data) {
      notFound.value = true
      return
    }
    markdown.value = res.data.markdown
    occurredAt.value = new Date(res.data.occurredAt)
    persistentImages.value = res.data.images
  } catch {
    if (operation.isActive()) notFound.value = true
  } finally {
    if (operation.isActive()) loading.value = false
  }
}

async function handleSave() {
  if (saving.value) return
  if (!occurredAt.value) {
    ElMessage.warning(i18nStore.t.diary.timeReq)
    return
  }

  const operation = operations.capture()
  if (!operation.isActive()) return
  const id = notebookId.value
  const storageKey = imageStorageKey.value
  saving.value = true
  try {
    // Collect only newly inserted draft images; persisted references stay inline.
    const images = collectDraftImages(storageKey, markdown.value)
    const payload = {
      notebookId: id,
      occurredAt: new Date(occurredAt.value).toISOString(),
      markdown: markdown.value,
      images
    }
    // Create or update depending on edit mode, then navigate to the detail page.
    const res = await operation.call(
      () =>
        isEdit.value
          ? window.api.updateDiary({ ...payload, diaryId: Number(props.diaryId) })
          : window.api.createDiary(payload),
      id
    )

    if (!operation.isActive() || !res) return
    if (!res.success || !res.data) {
      ElMessage.error(res.message || i18nStore.t.diary.saveFail)
      return
    }
    clearDraftImages(storageKey)
    ElMessage.success(i18nStore.t.diary.saveSuccess)
    await router.replace(`/notebooks/${notebookId.value}/diaries/${res.data.id}`)
  } catch {
    if (operation.isActive()) ElMessage.error(i18nStore.t.diary.saveFail)
  } finally {
    if (operation.isActive()) saving.value = false
  }
}

function handleCancel() {
  if (!operations.capture().isActive()) return
  if (isEdit.value) {
    router.push(`/notebooks/${notebookId.value}/diaries/${props.diaryId}`)
  } else {
    router.push(`/notebooks/${notebookId.value}/diaries`)
  }
}

onMounted(load)
</script>

<template>
  <div class="page-container">
    <header class="mx-auto mb-5 flex max-w-[900px] items-center gap-4">
      <button type="button" class="back-link" @click="handleCancel">
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
      />

      <div class="mt-5 flex justify-end gap-3">
        <button
          type="button"
          class="btn-secondary action-button"
          data-testid="cancel-button"
          @click="handleCancel"
        >
          {{ i18nStore.t.diary.back }}
        </button>
        <button
          type="button"
          class="btn-primary action-button"
          :disabled="saving"
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
