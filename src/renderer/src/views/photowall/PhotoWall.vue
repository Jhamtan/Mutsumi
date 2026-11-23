<script setup lang="ts">
import type { PhotoWallPhotoDTO, PhotoWallStateDTO, PhotoWallUsageDTO } from '@common/types'
import {
  PHOTOWALL_BATCH_MAX_BYTES,
  PHOTOWALL_MAX_IMAGES,
  PHOTOWALL_IMAGE_MAX_BYTES,
  PHOTOWALL_IMAGE_HARD_MAX_BYTES,
  PHOTOWALL_PORTRAIT_MAX_BYTES,
  PHOTOWALL_TOTAL_MAX_BYTES,
  PHOTOWALL_TOTAL_HARD_MAX_BYTES
} from '@common/photowall'
import { useI18nStore } from '@renderer/store/i18n'
import { useSessionOperation } from '@renderer/composables/useSessionOperation'
import {
  compressPhoto,
  readAsDataUrl,
  dataUrlBytes,
  hashImageDataUrl,
  PhotoWallImageError
} from '@renderer/utils/photo-wall'
import { loadPhotoWallPreview } from '@renderer/utils/photo-wall-preview'

const router = useRouter()
const operations = useSessionOperation()
const i18nStore = useI18nStore()
const t = computed(() => i18nStore.t.photowall)

const state = ref<PhotoWallStateDTO>({
  minImages: 10,
  photoCount: 0,
  portrait: null,
  rounded: false
})
const photos = ref<PhotoWallPhotoDTO[]>([])
const loading = ref(true)
const uploading = ref(false)
const loadFailed = ref(false)
const clearing = ref(false)

const photoInput = ref<HTMLInputElement | null>(null)
const portraitInput = ref<HTMLInputElement | null>(null)
const minImagesInput = ref(10)
const savingMin = ref(false)
const roundedInput = ref(false)
const usage = ref<PhotoWallUsageDTO>({
  imageMaxBytes: PHOTOWALL_IMAGE_MAX_BYTES,
  totalMaxBytes: PHOTOWALL_TOTAL_MAX_BYTES,
  usedBytes: 0
})
const imageLimitMiB = ref(PHOTOWALL_IMAGE_MAX_BYTES / (1024 * 1024))
const totalLimitMiB = ref(PHOTOWALL_TOTAL_MAX_BYTES / (1024 * 1024))
const limitsLoaded = ref(false)
const savingLimits = ref(false)
let loadRevision = 0

function formatMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2)
}

function showImageError(error: unknown, limit: number): void {
  if (error instanceof PhotoWallImageError) {
    const message =
      error.reason === 'unsupported'
        ? t.value.imageFormatHint
        : error.reason === 'pixel-limit'
          ? t.value.imagePixelLimit
          : error.reason === 'file-too-large'
            ? limit === PHOTOWALL_PORTRAIT_MAX_BYTES
              ? t.value.portraitTooLarge
              : t.value.singleImageTooLarge.replace('{size}', formatMiB(limit))
            : t.value.compressionFailed
    ElMessage.error(message)
  } else ElMessage.error(t.value.uploadFail)
}

const enough = computed(() => !loadFailed.value && state.value.photoCount >= state.value.minImages)

async function load() {
  const operation = operations.capture()
  if (!operation.isActive()) return
  const revision = ++loadRevision
  loading.value = true
  limitsLoaded.value = false
  try {
    // Fetch state, paginated previews and capacity limits in parallel; a stale revision aborts the update.
    const [stateRes, photosRes, limitsRes] = await Promise.all([
      operation.call(() => window.api.getPhotoWall()),
      loadPhotoWallPreview(operation),
      operation.call(() => window.api.getPhotoWallLimits())
    ])
    if (!operation.isActive() || revision !== loadRevision || !stateRes || !photosRes || !limitsRes)
      return
    loadFailed.value =
      !stateRes.success ||
      !stateRes.data ||
      !photosRes.success ||
      !photosRes.data ||
      !limitsRes.success ||
      !limitsRes.data
    if (limitsRes.success && limitsRes.data) {
      usage.value = limitsRes.data
      imageLimitMiB.value = limitsRes.data.imageMaxBytes / (1024 * 1024)
      totalLimitMiB.value = limitsRes.data.totalMaxBytes / (1024 * 1024)
      limitsLoaded.value = true
    }
    if (stateRes.success && stateRes.data) {
      state.value = stateRes.data
      minImagesInput.value = stateRes.data.minImages
      roundedInput.value = stateRes.data.rounded
    }
    photos.value = photosRes.success ? (photosRes.data ?? []) : []
    if (loadFailed.value) {
      ElMessage.error(
        stateRes.message ||
          limitsRes.message ||
          (photosRes.code === 'PHOTOWALL_PREVIEW_FAILED' ? t.value.loadFail : photosRes.message) ||
          t.value.loadFail
      )
    }
  } catch {
    if (!operation.isActive() || revision !== loadRevision) return
    loadFailed.value = true
    photos.value = []
    ElMessage.error(t.value.loadFail)
  } finally {
    if (operation.isActive() && revision === loadRevision) loading.value = false
  }
}

async function saveLimits(): Promise<void> {
  if (
    savingLimits.value ||
    loading.value ||
    uploading.value ||
    clearing.value ||
    !limitsLoaded.value
  )
    return
  const operation = operations.capture()
  if (!operation.isActive()) return
  // Validate the requested MiB values against hard bounds and current usage before persisting.
  const imageMaxBytes = imageLimitMiB.value * 1024 * 1024
  const totalMaxBytes = totalLimitMiB.value * 1024 * 1024
  if (
    !Number.isInteger(imageLimitMiB.value) ||
    imageLimitMiB.value < 1 ||
    imageMaxBytes > PHOTOWALL_IMAGE_HARD_MAX_BYTES ||
    !Number.isInteger(totalLimitMiB.value) ||
    totalMaxBytes < PHOTOWALL_TOTAL_MAX_BYTES ||
    totalMaxBytes > PHOTOWALL_TOTAL_HARD_MAX_BYTES
  ) {
    ElMessage.error(t.value.capacityRange)
    return
  }
  if (totalMaxBytes < usage.value.usedBytes) {
    ElMessage.error(t.value.capacityBelowUsage)
    return
  }
  savingLimits.value = true
  try {
    const response = await operation.call(() =>
      window.api.setPhotoWallLimits({ imageMaxBytes, totalMaxBytes })
    )
    if (!operation.isActive() || !response) return
    if (!response.success || !response.data) {
      ElMessage.error(
        response.code === 'PHOTOWALL_CAPACITY_EXCEEDED'
          ? t.value.capacityBelowUsage
          : t.value.capacitySaveFail
      )
      return
    }
    usage.value = response.data
    imageLimitMiB.value = response.data.imageMaxBytes / (1024 * 1024)
    totalLimitMiB.value = response.data.totalMaxBytes / (1024 * 1024)
    ElMessage.success(t.value.capacitySaved)
    await load()
  } catch {
    if (operation.isActive()) ElMessage.error(t.value.capacitySaveFail)
  } finally {
    if (operation.isActive()) savingLimits.value = false
  }
}

function pickPhotos() {
  photoInput.value?.click()
}

async function onPhotosChange(event: Event) {
  const operation = operations.capture()
  if (!operation.isActive()) return
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (
    files.length === 0 ||
    uploading.value ||
    clearing.value ||
    !limitsLoaded.value ||
    savingLimits.value
  )
    return
  if (files.length > PHOTOWALL_MAX_IMAGES) {
    ElMessage.error(t.value.tooMany)
    return
  }
  // Check the whole batch of raw files before reading/compressing; reject the batch rather than silently dropping images.
  if (files.reduce((total, file) => total + file.size, 0) > PHOTOWALL_BATCH_MAX_BYTES) {
    ElMessage.error(t.value.batchTooLarge)
    return
  }

  uploading.value = true
  try {
    // Compress each selected file within the per-image limit, tracking the batch total.
    const dataUrls: Array<{ url: string; hash: string | undefined }> = []
    const imageLimit = usage.value.imageMaxBytes
    let batchBytes = 0
    for (const file of files) {
      const url = await compressPhoto(file, imageLimit)
      if (!operation.isActive()) return
      const bytes = dataUrlBytes(url)
      if (bytes > imageLimit) {
        ElMessage.error(t.value.singleImageTooLarge.replace('{size}', formatMiB(imageLimit)))
        return
      }
      batchBytes += bytes
      if (batchBytes > PHOTOWALL_BATCH_MAX_BYTES) {
        ElMessage.error(t.value.batchTooLarge)
        return
      }
      const hash = await hashImageDataUrl(url)
      if (!operation.isActive()) return
      dataUrls.push({ url, hash })
    }

    // Dedupe: skip images that already exist or repeat within this batch to avoid duplicate uploads.
    const existing = new Set(photos.value.map((photo) => photo.dataUrl))
    const existingHashes = new Set(
      photos.value
        .map((photo) => photo.sourceHash)
        .filter((value): value is string => typeof value === 'string')
    )
    const seen = new Set<string>()
    const toAdd: string[] = []
    let skipped = 0
    for (const { url, hash } of dataUrls) {
      if (existing.has(url) || seen.has(url) || (hash !== undefined && existingHashes.has(hash))) {
        skipped++
      } else {
        seen.add(url)
        toAdd.push(url)
      }
    }

    // Verify the deduped set still fits the total capacity before uploading.
    if (
      toAdd.reduce((sum, url) => sum + dataUrlBytes(url), usage.value.usedBytes) >
      usage.value.totalMaxBytes
    ) {
      ElMessage.error(t.value.capacityExceeded)
      return
    }

    if (toAdd.length === 0) {
      ElMessage.warning(t.value.allDuplicates)
      return
    }

    const res = await operation.call(() => window.api.addPhotoWallPhotos(toAdd))
    if (!operation.isActive() || !res) return
    if (!res.success || !res.data) {
      ElMessage.error(
        res.code === 'PHOTOWALL_CAPACITY_EXCEEDED'
          ? t.value.capacityExceeded
          : res.code === 'IMAGE_TOO_LARGE'
            ? t.value.singleImageTooLarge.replace('{size}', formatMiB(imageLimit))
            : res.message || t.value.uploadFail
      )
      return
    }
    state.value.photoCount = res.data.photoCount
    if (skipped > 0) {
      ElMessage.success(
        t.value.addedWithSkipped
          .replace('{added}', String(res.data.added))
          .replace('{skipped}', String(skipped))
      )
    } else {
      ElMessage.success(t.value.photoCount.replace('{count}', String(res.data.photoCount)))
    }
    await load()
    if (!operation.isActive()) return
  } catch (error) {
    if (operation.isActive()) showImageError(error, usage.value.imageMaxBytes)
  } finally {
    if (operation.isActive()) uploading.value = false
  }
}

function pickPortrait() {
  portraitInput.value?.click()
}

async function onPortraitChange(event: Event) {
  const operation = operations.capture()
  if (!operation.isActive()) return
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || uploading.value || clearing.value || !limitsLoaded.value || savingLimits.value)
    return
  if (file.size > PHOTOWALL_PORTRAIT_MAX_BYTES) {
    ElMessage.error(t.value.portraitTooLarge)
    return
  }
  uploading.value = true
  try {
    // Read the portrait at full quality, then submit it and reload.
    const dataUrl = await readAsDataUrl(file)
    if (!operation.isActive()) return
    const res = await operation.call(() => window.api.setPhotoWallPortrait(dataUrl))
    if (!operation.isActive() || !res) return
    if (!res.success) {
      ElMessage.error(res.message || t.value.uploadFail)
      return
    }
    state.value.portrait = res.data ?? null
    ElMessage.success(t.value.uploadPortrait)
    await load()
    if (!operation.isActive()) return
  } catch (error) {
    if (operation.isActive()) showImageError(error, PHOTOWALL_PORTRAIT_MAX_BYTES)
  } finally {
    if (operation.isActive()) uploading.value = false
  }
}

async function removePortrait() {
  const operation = operations.capture()
  if (!operation.isActive()) return
  try {
    await ElMessageBox.confirm(t.value.removePortraitConfirm, t.value.removePortrait, {
      confirmButtonText: t.value.removePortrait,
      cancelButtonText: i18nStore.locale === 'en' ? 'Cancel' : '取消',
      type: 'warning'
    })
  } catch {
    return
  }
  if (!operation.isActive()) return
  try {
    // Clear the portrait and reload.
    const res = await operation.call(() => window.api.setPhotoWallPortrait(null))
    if (!operation.isActive() || !res) return
    if (!res.success || res.data !== null) {
      ElMessage.error(res.message || t.value.clearFail)
      return
    }
    state.value.portrait = null
    await load()
    if (!operation.isActive()) return
  } catch {
    if (operation.isActive()) ElMessage.error(t.value.clearFail)
  }
}

async function saveRounded(value: string | number | boolean) {
  const operation = operations.capture()
  if (!operation.isActive()) return
  const rounded = Boolean(value)
  try {
    const res = await operation.call(() => window.api.setPhotoWallRounded(rounded))
    if (!operation.isActive() || !res) return
    if (!res.success || res.data === undefined) {
      ElMessage.error(res.message || t.value.uploadFail)
      roundedInput.value = state.value.rounded
      return
    }
    state.value.rounded = res.data
    roundedInput.value = res.data
  } catch {
    if (operation.isActive()) ElMessage.error(t.value.uploadFail)
  }
}

async function saveMinImages() {
  if (savingMin.value) return
  const operation = operations.capture()
  if (!operation.isActive()) return
  savingMin.value = true
  try {
    const res = await operation.call(() => window.api.setPhotoWallMinImages(minImagesInput.value))
    if (!operation.isActive() || !res) return
    if (!res.success || !res.data) {
      ElMessage.error(res.message || t.value.uploadFail)
      return
    }
    state.value.minImages = res.data
  } catch {
    if (operation.isActive()) ElMessage.error(t.value.uploadFail)
  } finally {
    if (operation.isActive()) savingMin.value = false
  }
}

function preview() {
  if (!enough.value) {
    ElMessage.warning(t.value.notEnough.replace('{min}', String(state.value.minImages)))
    return
  }
  router.push('/photowall/view')
}

async function deletePhoto(photo: PhotoWallPhotoDTO) {
  const operation = operations.capture()
  if (!operation.isActive()) return
  try {
    const res = await operation.call(() => window.api.deletePhotoWallPhoto(photo.id))
    if (!operation.isActive() || !res) return
    if (!res.success) {
      ElMessage.error(res.message || t.value.uploadFail)
      return
    }
    state.value.photoCount = res.data ?? 0
    photos.value = photos.value.filter((item) => item.id !== photo.id)
    const capacity = await operation.call(() => window.api.getPhotoWallLimits())
    if (!operation.isActive() || !capacity) return
    if (capacity.success && capacity.data) usage.value = capacity.data
    else limitsLoaded.value = false
  } catch {
    if (operation.isActive()) ElMessage.error(t.value.uploadFail)
  }
}

async function clearPhotos() {
  if (clearing.value || uploading.value) return
  const operation = operations.capture()
  if (!operation.isActive()) return
  clearing.value = true
  try {
    await ElMessageBox.confirm(t.value.clearConfirm, t.value.clear, {
      confirmButtonText: t.value.clear,
      cancelButtonText: i18nStore.locale === 'en' ? 'Cancel' : '取消',
      type: 'warning'
    })
  } catch {
    if (operation.isActive()) clearing.value = false
    return
  }
  if (!operation.isActive()) return
  try {
    // Clear all photos and reload.
    const res = await operation.call(() => window.api.clearPhotoWall())
    if (!operation.isActive() || !res) return
    if (!res.success || res.data !== 0) {
      ElMessage.error(res.message || t.value.clearFail)
      return
    }
    state.value.photoCount = 0
    photos.value = []
    ElMessage.success(t.value.clearSuccess)
    await load()
    if (!operation.isActive()) return
  } catch {
    if (operation.isActive()) ElMessage.error(t.value.clearFail)
  } finally {
    if (operation.isActive()) clearing.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page-container">
    <header class="page-head max-w-[960px]">
      <div>
        <h1 class="page-head-title">{{ t.title }}</h1>
        <p class="page-subtitle">{{ t.subtitle }}</p>
      </div>
      <button type="button" class="btn-primary preview-button" :disabled="!enough" @click="preview">
        <span class="i-ep-video-play" aria-hidden="true"></span>
        {{ t.fullscreen }}
      </button>
    </header>

    <div class="mx-auto flex max-w-[960px] flex-col gap-[18px]">
      <section v-if="loadFailed && !loading" class="app-surface rounded-[18px] p-6" role="alert">
        <h2 class="mb-2 text-[15px] font-semibold">{{ t.recoveryTitle }}</h2>
        <p class="mb-3 text-xs text-ink-muted">{{ t.recoveryHint }}</p>
        <button type="button" class="btn-secondary" :disabled="clearing" @click="load">
          {{ t.retry }}
        </button>
      </section>
      <!-- 上传与人物图片 -->
      <div class="grid gap-[18px] md:grid-cols-2">
        <section class="app-surface rounded-[18px] p-6">
          <h2 class="mb-3 text-[15px] font-semibold">{{ t.photos }}</h2>
          <p class="mb-4 text-xs text-ink-muted">
            {{ t.photoCount.replace('{count}', String(state.photoCount)) }}
            <span v-if="!enough" class="text-accent-600">
              · {{ t.notEnough.replace('{min}', String(state.minImages)) }}
            </span>
          </p>
          <p class="mb-2 text-xs text-ink-muted">{{ t.batchLimitHint }}</p>
          <p class="mb-4 text-xs text-ink-muted">
            {{ t.singleImageHint.replace('{size}', String(usage.imageMaxBytes / (1024 * 1024))) }}
          </p>
          <div class="flex gap-2">
            <button
              type="button"
              class="btn-primary upload-button"
              :disabled="uploading || clearing || !limitsLoaded || savingLimits"
              @click="pickPhotos"
            >
              <span v-if="uploading" class="i-ep-loading animate-spin" aria-hidden="true"></span>
              <span v-else class="i-ep-upload" aria-hidden="true"></span>
              {{ t.uploadPhotos }}
            </button>
            <button
              v-if="photos.length || state.photoCount > 0 || loadFailed"
              type="button"
              class="btn-secondary upload-button"
              :disabled="loading || uploading || clearing"
              @click="clearPhotos"
            >
              <span class="i-ep-delete" aria-hidden="true"></span>
              {{ t.clear }}
            </button>
          </div>
          <input
            ref="photoInput"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,.png,.jpg,.jpeg,.gif,.webp"
            multiple
            class="hidden"
            @change="onPhotosChange"
          />
        </section>

        <section class="app-surface rounded-[18px] p-6">
          <h2 class="mb-3 text-[15px] font-semibold">{{ t.portrait }}</h2>
          <p class="mb-2 text-xs leading-relaxed text-ink-muted" data-testid="portrait-guidance">
            {{ t.roleTip }}
          </p>
          <p class="mb-4 text-xs leading-relaxed text-ink-muted">{{ t.portraitFormatHint }}</p>
          <div class="flex items-center gap-3">
            <div
              v-if="state.portrait"
              class="h-16 w-16 overflow-hidden rounded-xl border border-solid border-[#e3efee] bg-[#f8fbfa]"
            >
              <img :src="state.portrait" class="h-full w-full object-contain" :alt="t.portrait" />
            </div>
            <div class="flex flex-col gap-2">
              <button
                type="button"
                class="btn-secondary portrait-button"
                :disabled="uploading || clearing || !limitsLoaded || savingLimits"
                @click="pickPortrait"
              >
                <span class="i-ep-picture" aria-hidden="true"></span>
                {{ state.portrait ? t.replacePortrait : t.uploadPortrait }}
              </button>
              <button
                v-if="state.portrait || loadFailed"
                type="button"
                class="text-link self-start"
                :disabled="loading || uploading || clearing"
                @click="removePortrait"
              >
                {{ t.removePortrait }}
              </button>
            </div>
          </div>
          <input
            ref="portraitInput"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,.png,.jpg,.jpeg,.gif,.webp"
            class="hidden"
            @change="onPortraitChange"
          />
        </section>
      </div>

      <!-- 设置 -->
      <section class="app-surface rounded-[18px] p-6">
        <h2 class="mb-4 text-[15px] font-semibold">{{ t.settingsTitle }}</h2>
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label for="photo-single-limit" class="mb-2 block text-sm font-semibold">{{
              t.singleImageLimit
            }}</label>
            <el-input-number
              id="photo-single-limit"
              v-model="imageLimitMiB"
              :min="1"
              :max="10"
              :precision="0"
              :step="1"
              :disabled="loading || savingLimits || uploading || clearing || !limitsLoaded"
              data-testid="photo-single-limit"
            />
            <span class="ml-2 text-xs text-ink-muted">MiB</span>
            <p class="mt-2 text-xs leading-relaxed text-ink-muted">
              {{ t.singleImageSettingHint }}
            </p>
          </div>
          <div>
            <label for="photo-total-limit" class="mb-2 block text-sm font-semibold">{{
              t.totalImageLimit
            }}</label>
            <el-input-number
              id="photo-total-limit"
              v-model="totalLimitMiB"
              :min="64"
              :max="512"
              :precision="0"
              :step="1"
              :disabled="loading || savingLimits || uploading || clearing || !limitsLoaded"
              data-testid="photo-total-limit"
            />
            <span class="ml-2 text-xs text-ink-muted">MiB</span>
            <p class="mt-2 text-xs leading-relaxed text-ink-muted">{{ t.totalImageSettingHint }}</p>
          </div>
        </div>
        <div class="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p class="text-xs text-ink-muted" data-testid="photo-capacity-usage">
            {{
              t.capacityUsage
                .replace('{used}', formatMiB(usage.usedBytes))
                .replace('{limit}', formatMiB(usage.totalMaxBytes))
            }}
          </p>
          <button
            type="button"
            class="btn-secondary save-button"
            :disabled="loading || savingLimits || uploading || clearing || !limitsLoaded"
            data-testid="save-photo-limits"
            @click="saveLimits"
          >
            {{ t.saveCapacity }}
          </button>
        </div>
        <p class="mt-3 text-xs leading-relaxed text-ink-muted">{{ t.capacityPerformanceHint }}</p>
        <div class="my-5 border-t border-solid border-[#eef5f3]"></div>
        <h3 class="mb-1 text-[15px] font-semibold">{{ t.minImages }}</h3>
        <p class="mb-4 text-xs text-ink-muted">{{ t.minImagesHint }}</p>
        <div class="flex items-center gap-3">
          <el-input-number v-model="minImagesInput" :min="2" :max="100" />
          <button
            type="button"
            class="btn-secondary save-button"
            :disabled="savingMin"
            @click="saveMinImages"
          >
            {{ t.save }}
          </button>
        </div>

        <div
          class="mt-4 flex items-center justify-between border-t border-solid border-[#eef5f3] pt-4"
        >
          <div>
            <h3 class="text-sm font-semibold">{{ t.rounded }}</h3>
            <p class="mt-1 text-xs text-ink-muted">{{ t.roundedHint }}</p>
          </div>
          <el-switch v-model="roundedInput" @change="saveRounded" />
        </div>
      </section>

      <!-- 照片网格 -->
      <div v-if="loading" class="app-surface rounded-[18px] p-6">
        <el-skeleton :rows="4" animated />
      </div>

      <div v-else-if="photos.length === 0 && !loadFailed" class="empty-state">
        <span class="empty-icon" aria-hidden="true"><span class="i-ep-picture"></span></span>
        <p class="empty-title">{{ t.empty }}</p>
        <p class="empty-hint">{{ t.emptyHint.replace('{min}', String(state.minImages)) }}</p>
      </div>

      <div v-else class="columns-2 gap-2 sm:columns-3 lg:columns-5">
        <div
          v-for="photo in photos"
          :key="photo.id"
          class="group relative mb-2 break-inside-avoid overflow-hidden border border-solid border-[#e3efee] bg-[#f8fbfa]"
          :class="state.rounded ? 'rounded-xl' : ''"
        >
          <img :src="photo.dataUrl" class="block h-auto w-full" alt="" loading="lazy" />
          <button
            type="button"
            class="delete-overlay"
            :aria-label="t.deletePhoto"
            @click="deletePhoto(photo)"
          >
            <span class="i-ep-delete" aria-hidden="true"></span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.preview-button {
  width: auto;
  min-height: 42px;
  padding: 0 18px;
}

.upload-button {
  width: auto;
  min-height: 42px;
  padding: 0 16px;
}

.portrait-button {
  width: auto;
  min-height: 38px;
  padding: 0 14px;
}

.save-button {
  width: auto;
  min-height: 38px;
  padding: 0 16px;
}

.delete-overlay {
  position: absolute;
  right: 6px;
  top: 6px;
  display: inline-flex;
  height: 28px;
  width: 28px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 8px;
  background: rgb(0 0 0 / 45%);
  color: #fff;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.16s ease;
}

.group:hover .delete-overlay {
  opacity: 1;
}

.delete-overlay:hover {
  background: rgb(229 77 77 / 85%);
}
</style>
