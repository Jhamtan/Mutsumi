<script setup lang="ts">
import type { PhotoWallPhotoDTO } from '@common/types'
import { useI18nStore } from '@renderer/store/i18n'
import { useSessionOperation } from '@renderer/composables/useSessionOperation'
import { loadPhotoWallPreview } from '@renderer/utils/photo-wall-preview'

const router = useRouter()
const operations = useSessionOperation()
const i18nStore = useI18nStore()
const t = computed(() => i18nStore.t.photowall)

const photos = ref<PhotoWallPhotoDTO[]>([])
const portrait = ref<string | null>(null)
const rounded = ref(false)
const minImages = ref(10)
const columnCount = ref(5)
const loading = ref(true)

interface WallImage {
  src: string
}

interface WallColumn {
  imgs: WallImage[]
  duration: number
}

function repeatTo(imgs: WallImage[], min: number): WallImage[] {
  if (imgs.length === 0) return []
  const out: WallImage[] = []
  while (out.length < min) out.push(...imgs)
  return out
}

function buildColumns(srcs: string[], count: number): WallColumn[] {
  const shuffled = [...srcs].sort(() => Math.random() - 0.5)
  const cols: WallImage[][] = Array.from({ length: count }, () => [])
  shuffled.forEach((src, index) => {
    cols[index % count].push({ src })
  })
  // Repeat each column to at least 8 images so a single column is taller than one screen and scrolls seamlessly.
  return cols.map((imgs, index) => ({
    imgs: repeatTo(imgs, 8),
    duration: 45 + index * 7
  }))
}

const columns = computed<WallColumn[]>(() =>
  buildColumns(
    photos.value.map((photo) => photo.dataUrl),
    columnCount.value
  )
)

async function load() {
  const operation = operations.capture()
  if (!operation.isActive()) return
  loading.value = true
  try {
    // Fetch state and paginated previews in parallel.
    const [stateRes, photosRes] = await Promise.all([
      operation.call(() => window.api.getPhotoWall()),
      loadPhotoWallPreview(operation)
    ])
    if (!operation.isActive() || !stateRes || !photosRes) return
    if (!stateRes.success || !stateRes.data || !photosRes.success || !photosRes.data) {
      ElMessage.error(
        stateRes.message ||
          (photosRes.code === 'PHOTOWALL_PREVIEW_FAILED' ? t.value.loadFail : photosRes.message) ||
          t.value.loadFail
      )
      await router.replace('/photowall')
      if (!operation.isActive()) return
      return
    }
    portrait.value = stateRes.data.portrait
    rounded.value = stateRes.data.rounded
    minImages.value = stateRes.data.minImages
    photos.value = photosRes.success ? (photosRes.data ?? []) : []
  } catch {
    if (operation.isActive()) ElMessage.error(t.value.loadFail)
  } finally {
    if (operation.isActive()) loading.value = false
  }
}

function exit() {
  router.push('/photowall')
}

const exporting = ref(false)
const exportDialogVisible = ref(false)
const exportFilePath = ref('')

async function exportWallpaper() {
  if (exporting.value) return
  const operation = operations.capture()
  if (!operation.isActive()) return
  exporting.value = true
  try {
    // Trigger the native save dialog and export via the main process.
    const res = await operation.call(() => window.api.exportPhotoWall())
    if (!operation.isActive() || !res) return
    if (!res.success || !res.data) {
      ElMessage.error(
        res.code === 'PHOTOWALL_CAPACITY_EXCEEDED'
          ? t.value.capacityExceeded
          : res.message || t.value.exportFail
      )
      return
    }
    if (res.data.canceled) return
    exportFilePath.value = res.data.filePath ?? ''
    exportDialogVisible.value = true
  } catch {
    if (operation.isActive()) ElMessage.error(t.value.exportFail)
  } finally {
    if (operation.isActive()) exporting.value = false
  }
}

onMounted(() => {
  void load()
})
</script>

<template>
  <div class="wall">
    <div v-if="loading" class="wall-loading">
      <span class="i-ep-loading animate-spin text-2xl" aria-hidden="true"></span>
    </div>

    <template v-else>
      <div v-if="photos.length === 0" class="wall-empty">
        <p>{{ t.emptyHint.replace('{min}', String(minImages)) }}</p>
        <button type="button" class="wall-exit" @click="exit">{{ t.exit }}</button>
      </div>

      <template v-else>
        <div class="wall-track" :class="{ 'is-rounded': rounded }">
          <div v-for="(col, index) in columns" :key="index" class="wall-col">
            <div class="wall-col-inner" :style="{ animationDuration: `${col.duration}s` }">
              <img v-for="(img, j) in col.imgs" :key="j" :src="img.src" alt="" />
              <img
                v-for="(img, j) in col.imgs"
                :key="`b-${j}`"
                :src="img.src"
                alt=""
                aria-hidden="true"
              />
            </div>
          </div>
        </div>
        <img v-if="portrait" :src="portrait" class="portrait" alt="portrait" />
      </template>

      <div v-if="photos.length > 0" class="wall-actions">
        <button type="button" class="wall-action" :disabled="exporting" @click="exportWallpaper">
          <span v-if="exporting" class="i-ep-loading animate-spin" aria-hidden="true"></span>
          <span v-else class="i-ep-download" aria-hidden="true"></span>
          {{ exporting ? t.exporting : t.export }}
        </button>
        <button type="button" class="wall-action" @click="exit">
          <span class="i-ep-close" aria-hidden="true"></span>
          {{ t.exit }}
        </button>
      </div>
    </template>

    <el-dialog
      v-model="exportDialogVisible"
      :title="t.exportTitle"
      width="min(460px, 92vw)"
      append-to-body
    >
      <p class="mb-2 text-[13px] text-ink-muted">{{ t.exportSuccess }}</p>
      <p class="mb-3 break-all rounded-lg bg-[#f5f9f8] px-3 py-2 text-xs text-ink-soft">
        {{ exportFilePath }}
      </p>
      <p class="text-[13px] leading-relaxed text-ink">{{ t.exportHow }}</p>
      <p class="mt-3 text-[13px] leading-relaxed text-ink-muted">{{ t.exportProps }}</p>
      <a
        class="text-link mt-3 inline-block text-[13px]"
        href="https://docs.wallpaperengine.io/en/web/overview.html"
        target="_blank"
        rel="noreferrer"
      >
        {{ t.exportDocs }}
        <span class="i-ep-top-right text-xs" aria-hidden="true"></span>
      </a>
      <template #footer>
        <button type="button" class="btn-primary" @click="exportDialogVisible = false">
          {{ i18nStore.locale === 'en' ? 'OK' : '确定' }}
        </button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.wall {
  position: fixed;
  inset: 0;
  z-index: 50;
  overflow: hidden;
  background: linear-gradient(180deg, #0f1b2d 0%, #16283f 100%);
}

.wall-track {
  display: flex;
  gap: 4px;
  height: 100%;
  padding: 4px;
}

.wall-col {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.wall-col-inner {
  display: flex;
  flex-direction: column;
  gap: 4px;
  animation-name: wall-scroll;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
}

.wall-col-inner img {
  display: block;
  width: 100%;
  height: auto;
}

.wall-track.is-rounded .wall-col {
  border-radius: 8px;
}

.wall-track.is-rounded .wall-col-inner img {
  border-radius: 8px;
}

@keyframes wall-scroll {
  from {
    transform: translateY(0);
  }
  to {
    transform: translateY(-50%);
  }
}

.portrait {
  position: fixed;
  left: 50%;
  bottom: 0;
  z-index: 10;
  height: auto;
  max-height: 97vh;
  max-width: 50vw;
  width: auto;
  object-fit: contain;
  transform: translate(-50%, 0);
  pointer-events: none;
  filter: drop-shadow(0 12px 40px rgb(0 0 0 / 45%));
}

.wall-actions {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 20;
  display: flex;
  gap: 8px;
}

.wall-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 38px;
  padding: 0 16px;
  border: 0;
  border-radius: 999px;
  background: rgb(0 0 0 / 35%);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.16s ease;
}

.wall-action:hover {
  background: rgb(0 0 0 / 55%);
}

.wall-action:disabled {
  opacity: 0.6;
  cursor: wait;
}

.wall-exit {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 20;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 38px;
  padding: 0 16px;
  border: 0;
  border-radius: 999px;
  background: rgb(0 0 0 / 35%);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.16s ease;
}

.wall-exit:hover {
  background: rgb(0 0 0 / 55%);
}

.wall-loading {
  display: flex;
  height: 100%;
  align-items: center;
  justify-content: center;
  color: #fff;
}

.wall-empty {
  display: flex;
  height: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  color: #fff;
}
</style>
