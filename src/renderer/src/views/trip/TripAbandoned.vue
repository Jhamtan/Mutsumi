<script setup lang="ts">
import type { ItinerarySummaryDTO } from '@common/types'
import { useI18nStore } from '@renderer/store/i18n'
import { useSessionOperation } from '@renderer/composables/useSessionOperation'
import { formatClock } from '@renderer/utils/itinerary'

const i18nStore = useI18nStore()
const operations = useSessionOperation()

const trips = ref<ItinerarySummaryDTO[]>([])
const loading = ref(true)
const cancelLabel = computed(() => (i18nStore.locale === 'en' ? 'Cancel' : '取消'))

async function load() {
  const operation = operations.capture()
  if (!operation.isActive()) return
  loading.value = true
  try {
    const res = await operation.call(() => window.api.listAbandonedItineraries())
    if (!operation.isActive() || !res) return
    if (!res.success) {
      ElMessage.error(res.message || i18nStore.t.trip.loadFail)
      return
    }
    trips.value = res.data ?? []
  } catch {
    if (operation.isActive()) ElMessage.error(i18nStore.t.trip.loadFail)
  } finally {
    if (operation.isActive()) loading.value = false
  }
}

async function restore(trip: ItinerarySummaryDTO) {
  const operation = operations.capture()
  if (!operation.isActive()) return
  try {
    const res = await operation.call(() => window.api.restoreItinerary(trip.id))
    if (!operation.isActive() || !res) return
    if (!res.success || !res.data) {
      ElMessage.error(res.message || i18nStore.t.trip.restoreFail)
      return
    }
    ElMessage.success(i18nStore.t.trip.restoreSuccess)
    await load()
    if (!operation.isActive()) return
  } catch {
    if (operation.isActive()) ElMessage.error(i18nStore.t.trip.restoreFail)
  }
}

async function purge(trip: ItinerarySummaryDTO) {
  const operation = operations.capture()
  if (!operation.isActive()) return
  try {
    await ElMessageBox.confirm(i18nStore.t.trip.purgeConfirm, i18nStore.t.trip.purgeTitle, {
      confirmButtonText: i18nStore.t.trip.purge,
      cancelButtonText: cancelLabel.value,
      type: 'warning'
    })
  } catch {
    return
  }
  // Confirm, then permanently delete and reload.
  if (!operation.isActive()) return
  try {
    const res = await operation.call(() => window.api.purgeItinerary(trip.id))
    if (!operation.isActive() || !res) return
    if (!res.success || !res.data) {
      ElMessage.error(res.message || i18nStore.t.trip.purgeFail)
      return
    }
    ElMessage.success(i18nStore.t.trip.purgeSuccess)
    await load()
    if (!operation.isActive()) return
  } catch {
    if (operation.isActive()) ElMessage.error(i18nStore.t.trip.purgeFail)
  }
}

onMounted(load)
</script>

<template>
  <div class="page-container">
    <header class="page-head max-w-[1040px]">
      <div>
        <router-link to="/trips" class="back-link">
          <span class="i-ep-back" aria-hidden="true"></span>
          {{ i18nStore.t.trip.title }}
        </router-link>
        <h1 class="page-head-title">{{ i18nStore.t.trip.abandoned }}</h1>
        <p class="page-subtitle">{{ i18nStore.t.trip.abandonedEmptyHint }}</p>
      </div>
    </header>

    <div v-if="loading" class="card-grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
      <div v-for="n in 2" :key="n" class="app-surface trip-card skeleton-card">
        <el-skeleton :rows="3" animated />
      </div>
    </div>

    <div v-else-if="trips.length === 0" class="empty-state max-w-[1040px]">
      <span class="empty-icon" aria-hidden="true"><span class="i-ep-delete"></span></span>
      <p class="empty-title">{{ i18nStore.t.trip.abandonedEmpty }}</p>
      <p class="empty-hint">{{ i18nStore.t.trip.abandonedEmptyHint }}</p>
    </div>

    <div v-else class="card-grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
      <div v-for="trip in trips" :key="trip.id" class="app-surface trip-card">
        <h2 class="m-0 break-words text-base font-semibold tracking-[-0.01em]">
          {{ trip.name }}
        </h2>
        <p class="mt-2 flex items-center gap-2 text-[13px] font-medium">
          <span class="i-ep-position text-accent-600" aria-hidden="true"></span>
          {{ trip.startPlaceName || '…' }} → {{ trip.endPlaceName || '…' }}
        </p>
        <div class="mt-3 grid grid-cols-2 gap-2 text-xs">
          <div class="meta-chip">
            <span class="text-ink-soft">{{ i18nStore.t.trip.departure }}</span>
            <span class="font-medium">{{ formatClock(trip.startTime) }}</span>
          </div>
          <div class="meta-chip">
            <span class="text-ink-soft">{{ i18nStore.t.trip.arrival }}</span>
            <span class="font-medium">{{ formatClock(trip.endTime) }}</span>
          </div>
        </div>

        <div class="mt-4 flex gap-2">
          <button type="button" class="btn-secondary abandon-btn" @click="restore(trip)">
            <span class="i-ep-refresh-left" aria-hidden="true"></span>
            {{ i18nStore.t.trip.restore }}
          </button>
          <button type="button" class="btn-danger abandon-btn" @click="purge(trip)">
            <span class="i-ep-delete" aria-hidden="true"></span>
            {{ i18nStore.t.trip.purge }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.trip-card {
  display: flex;
  min-height: 150px;
  flex-direction: column;
  padding: 20px;
  border-radius: 18px;
}

.meta-chip {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 10px;
  background: #f5f9f8;
}

.abandon-btn {
  width: auto;
  min-height: 36px;
  flex: 1;
  padding: 0 12px;
}

.btn-danger {
  display: inline-flex;
  min-height: 36px;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid #f3c4c4;
  border-radius: 12px;
  background: #fdeaea;
  padding: 0 12px;
  color: #d64b4b;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.16s ease;
}

.btn-danger:hover {
  background: #fbdcdc;
}

.skeleton-card {
  cursor: default;
}
</style>
