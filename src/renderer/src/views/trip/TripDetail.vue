<script setup lang="ts">
import type { ItineraryDTO } from '@common/itinerary'
import TripDiagram from '@renderer/components/TripDiagram.vue'
import { useI18nStore } from '@renderer/store/i18n'
import { useSessionOperation } from '@renderer/composables/useSessionOperation'
import { formatTripDate } from '@renderer/utils/itinerary'

const props = defineProps<{ itineraryId: string }>()
const router = useRouter()
const operations = useSessionOperation()
const i18nStore = useI18nStore()
const itinerary = ref<ItineraryDTO | null>(null)
const loading = ref(true)
const failed = ref(false)
const subtitle = computed(() => {
  const date = formatTripDate(itinerary.value?.startTime, i18nStore.locale)
  return date
    ? i18nStore.t.trip.diagramSubtitle.replace('{date}', date)
    : i18nStore.t.trip.diagramEmptyDate
})

async function load(): Promise<void> {
  const operation = operations.capture()
  if (!operation.isActive()) return
  const id = Number(props.itineraryId)
  if (!Number.isSafeInteger(id) || id <= 0) {
    failed.value = true
    loading.value = false
    return
  }
  loading.value = true
  failed.value = false
  try {
    const response = await operation.call(() => window.api.getItinerary(id))
    if (!operation.isActive() || !response || Number(props.itineraryId) !== id) return
    if (!response.success || !response.data || response.data.id !== id) {
      failed.value = true
      return
    }
    itinerary.value = response.data
  } catch {
    if (operation.isActive()) failed.value = true
  } finally {
    if (operation.isActive()) loading.value = false
  }
}

function openEditor(): void {
  if (!operations.capture().isActive() || !itinerary.value || loading.value) return
  void router.push(`/trips/${itinerary.value.id}/edit`)
}

onMounted(() => {
  void load()
})
</script>

<template>
  <div class="page-container">
    <header class="page-head max-w-[1040px]">
      <div class="min-w-0">
        <router-link to="/trips" class="back-link">
          <span class="i-ep-arrow-left" aria-hidden="true"></span>
          {{ i18nStore.t.trip.backToList }}
        </router-link>
        <h1 class="page-head-title mt-3 break-words" data-testid="trip-name">
          {{ itinerary?.name || i18nStore.t.trip.viewTitle }}
        </h1>
        <p class="page-subtitle" data-testid="trip-subtitle">{{ subtitle }}</p>
      </div>
    </header>

    <div v-if="loading" class="app-surface max-w-[1040px] rounded-[18px] p-6">
      <el-skeleton :rows="6" animated />
    </div>
    <div v-else-if="failed" class="empty-state max-w-[1040px]" role="alert">
      <p>{{ i18nStore.t.trip.notFound }}</p>
      <button
        type="button"
        class="btn-secondary retry-button"
        data-testid="trip-retry"
        @click="load"
      >
        {{ i18nStore.t.photowall.retry }}
      </button>
    </div>
    <div
      v-else-if="itinerary"
      class="diagram-entry max-w-[1040px]"
      role="button"
      tabindex="0"
      :aria-label="i18nStore.t.trip.editDiagram"
      :title="i18nStore.t.trip.editDiagram"
      data-testid="edit-trip-diagram"
      @click="openEditor"
      @keydown.enter.prevent="openEditor"
      @keydown.space.prevent="openEditor"
    >
      <TripDiagram
        :start-time="itinerary.startTime"
        :places="itinerary.places"
        :legs="itinerary.legs"
      />
      <span class="diagram-edit-hint">{{ i18nStore.t.trip.editDiagram }}</span>
    </div>
  </div>
</template>

<style scoped>
.diagram-entry {
  position: relative;
  padding: 22px 24px 30px;
  border: 1px solid #d7e4df;
  border-radius: 18px;
  background: #ffffff;
  cursor: pointer;
}
.diagram-entry:hover {
  border-color: #286a51;
}
.diagram-entry:focus-visible {
  outline: 2px solid #286a51;
  outline-offset: 4px;
}
.diagram-edit-hint {
  display: block;
  margin-top: 18px;
  color: #286a51;
  font-size: 12px;
  text-align: center;
  opacity: 0;
}
.diagram-entry:hover .diagram-edit-hint,
.diagram-entry:focus-visible .diagram-edit-hint {
  opacity: 1;
}
.retry-button {
  width: auto;
  padding: 0 20px;
}
@media (max-width: 720px) {
  .diagram-entry {
    padding: 14px 12px 24px;
  }
}
</style>
