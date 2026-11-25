<script setup lang="ts">
import type { ItinerarySummaryDTO } from '@common/types'
import { useI18nStore } from '@renderer/store/i18n'
import { useSessionOperation } from '@renderer/composables/useSessionOperation'
import { formatClock, formatTripDate } from '@renderer/utils/itinerary'

const router = useRouter()
const operations = useSessionOperation()
const i18nStore = useI18nStore()

const trips = ref<ItinerarySummaryDTO[]>([])
const loading = ref(true)

async function load() {
  const operation = operations.capture()
  if (!operation.isActive()) return
  loading.value = true
  try {
    const res = await operation.call(() => window.api.listItineraries())
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

function openTrip(trip: ItinerarySummaryDTO) {
  if (!operations.capture().isActive()) return
  void router.push(`/trips/${trip.id}`)
}

function tripSubtitle(trip: ItinerarySummaryDTO): string {
  const date = formatTripDate(trip.startTime, i18nStore.locale)
  return date
    ? i18nStore.t.trip.diagramSubtitle.replace('{date}', date)
    : i18nStore.t.trip.diagramEmptyDate
}

function routeText(trip: ItinerarySummaryDTO): string {
  const from = trip.startPlaceName || '…'
  const to = trip.endPlaceName || '…'
  return `${from} → ${to}`
}

async function confirmDelete(trip: ItinerarySummaryDTO) {
  const operation = operations.capture()
  if (!operation.isActive()) return
  try {
    await ElMessageBox.confirm(i18nStore.t.trip.deleteConfirm, i18nStore.t.trip.deleteTitle, {
      confirmButtonText: i18nStore.t.trip.delete,
      cancelButtonText: i18nStore.locale === 'en' ? 'Cancel' : '取消',
      type: 'warning'
    })
  } catch {
    return
  }
  // Confirm, then soft-delete and reload the list.
  if (!operation.isActive()) return
  try {
    const res = await operation.call(() => window.api.deleteItinerary(trip.id))
    if (!operation.isActive() || !res) return
    if (!res.success || !res.data) {
      ElMessage.error(res.message || i18nStore.t.trip.deleteFail)
      return
    }
    ElMessage.success(i18nStore.t.trip.deleteSuccess)
    await load()
    if (!operation.isActive()) return
  } catch {
    if (operation.isActive()) ElMessage.error(i18nStore.t.trip.deleteFail)
  }
}

onMounted(load)
</script>

<template>
  <div class="page-container">
    <header class="page-head max-w-[1040px]">
      <div>
        <h1 class="page-head-title">{{ i18nStore.t.trip.title }}</h1>
        <p class="page-subtitle">{{ i18nStore.t.trip.subtitle }}</p>
      </div>
      <div class="flex items-center gap-3">
        <router-link to="/trips/abandoned" class="locale-button">
          <span class="i-ep-delete" aria-hidden="true"></span>
          {{ i18nStore.t.trip.abandoned }}
        </router-link>
        <button type="button" class="btn-primary create-button" @click="router.push('/trips/new')">
          <span class="i-ep-plus" aria-hidden="true"></span>
          {{ i18nStore.t.trip.create }}
        </button>
      </div>
    </header>

    <div v-if="loading" class="card-grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
      <div v-for="n in 3" :key="n" class="app-surface trip-card skeleton-card">
        <el-skeleton :rows="3" animated />
      </div>
    </div>

    <div v-else-if="trips.length === 0" class="empty-state max-w-[1040px]">
      <span class="empty-icon" aria-hidden="true"><span class="i-ep-position"></span></span>
      <p class="empty-title">{{ i18nStore.t.trip.listEmpty }}</p>
      <p class="empty-hint">{{ i18nStore.t.trip.listEmptyHint }}</p>
    </div>

    <div v-else class="card-grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
      <div
        v-for="trip in trips"
        :key="trip.id"
        class="app-surface trip-card"
        role="button"
        tabindex="0"
        :title="i18nStore.t.trip.viewTitle"
        :aria-label="`${i18nStore.t.trip.viewTitle}：${trip.name}`"
        @click="openTrip(trip)"
        @keyup.enter.self="openTrip(trip)"
        @keydown.space.self.prevent="openTrip(trip)"
      >
        <div class="flex items-start justify-between gap-3">
          <h2 class="m-0 break-words text-base font-semibold tracking-[-0.01em]">
            {{ trip.name }}
          </h2>
          <button
            type="button"
            class="delete-btn"
            :aria-label="i18nStore.t.trip.delete"
            @click.stop="confirmDelete(trip)"
          >
            <span class="i-ep-delete" aria-hidden="true"></span>
          </button>
        </div>

        <p class="mb-0 mt-2 text-xs text-ink-soft">{{ tripSubtitle(trip) }}</p>
        <p class="mt-3 flex items-center gap-2 text-[13px] font-medium">
          <span class="i-ep-position text-accent-600" aria-hidden="true"></span>
          {{ routeText(trip) }}
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

        <p class="mt-3 text-[11px] text-ink-soft">
          {{ i18nStore.t.trip.placesCount.replace('{count}', String(trip.placeCount)) }}
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.create-button {
  width: auto;
  min-height: 42px;
  padding: 0 18px;
}

.trip-card {
  position: relative;
  display: flex;
  min-height: 150px;
  flex-direction: column;
  padding: 20px;
  border-radius: 18px;
  cursor: pointer;
  transition:
    transform 0.16s ease,
    box-shadow 0.16s ease;
}

.trip-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 20px 50px -28px rgb(42 83 101 / 35%);
}

.delete-btn {
  display: inline-flex;
  height: 28px;
  width: 28px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #a5bbb9;
  cursor: pointer;
  transition:
    background-color 0.16s ease,
    color 0.16s ease;
}

.delete-btn:hover {
  background: #fdeaea;
  color: #e54d4d;
}

.meta-chip {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 10px;
  background: #f5f9f8;
}

.skeleton-card {
  cursor: default;
}
</style>
