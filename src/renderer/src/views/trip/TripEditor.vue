<script setup lang="ts">
import type { TransportMode } from '@common/types'
import {
  ITINERARY_MAX_DURATION_MINUTES,
  ITINERARY_MAX_PLACES,
  ITINERARY_MAX_STAY_MINUTES,
  ITINERARY_MIN_PLACES,
  ITINERARY_NAME_MAX_LENGTH,
  TRANSPORT_MODES
} from '@common/itinerary'
import TripDiagram from '@renderer/components/TripDiagram.vue'
import { useI18nStore } from '@renderer/store/i18n'
import { useSessionOperation } from '@renderer/composables/useSessionOperation'
import { formatTripDate } from '@renderer/utils/itinerary'

const props = defineProps<{ itineraryId?: string }>()
const router = useRouter()
const operations = useSessionOperation()
const i18nStore = useI18nStore()
const t = computed(() => i18nStore.t.trip)
const itineraryId = computed(() => (props.itineraryId ? Number(props.itineraryId) : null))
const isEdit = computed(() => itineraryId.value !== null)

const tripName = ref('')
const startTime = ref<Date | null>(isEdit.value ? null : new Date())
const places = ref<{ name: string; stayMinutes: number }[]>([])
const legs = ref<{ mode: TransportMode; durationMinutes: number }[]>([])
const loading = ref(isEdit.value)
const saving = ref(false)
const confirming = ref(false)
const navigating = ref(false)
const busy = computed(() => loading.value || saving.value || confirming.value || navigating.value)
const disabled = computed(() => busy.value || !operations.capture().isActive())
const navigationTarget = ref<string | null>(null)
const baseline = ref<string | null>(null)

const nameDialog = ref(false)
const nameForm = ref('')
const placeDialogIndex = ref<number | null>(null)
const placeForm = reactive({ name: '', stayMinutes: 0, departureTime: null as Date | null })
const legDialogIndex = ref<number | null>(null)
const legForm = reactive({ mode: 'car' as TransportMode, durationMinutes: 30 })
const addDialog = ref(false)
const addForm = reactive({ name: '', stayMinutes: 0, legIndex: 0 })

const displayName = computed(
  () =>
    tripName.value.trim() ||
    `${places.value[0]?.name ?? t.value.start} → ${places.value.at(-1)?.name ?? t.value.end}`
)
const subtitle = computed(() => {
  const date = formatTripDate(startTime.value, i18nStore.locale)
  return date ? t.value.diagramSubtitle.replace('{date}', date) : t.value.diagramEmptyDate
})
const modeOptions = computed(() =>
  TRANSPORT_MODES.map((mode) => ({
    value: mode.value,
    label: i18nStore.locale === 'en' ? mode.en : mode.label
  }))
)
const placeDialogTitle = computed(() => {
  const index = placeDialogIndex.value
  if (index === null) return ''
  if (index === 0) return t.value.editStart
  return isMiddle(index) ? t.value.editMiddle : t.value.editEnd
})

function snapshot() {
  return JSON.stringify({
    name: tripName.value,
    startTime: startTime.value,
    places: places.value,
    legs: legs.value
  })
}

const dirty = computed(() => baseline.value !== null && baseline.value !== snapshot())

function isMiddle(index: number) {
  return index > 0 && index < places.value.length - 1
}

function validName(name: string) {
  return name.trim().length > 0 && name.trim().length <= ITINERARY_NAME_MAX_LENGTH
}

function validMinutes(value: number, min: number, max: number) {
  return Number.isInteger(value) && value >= min && value <= max
}

function validStart(value: Date | null): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function openName() {
  if (disabled.value) return
  nameForm.value = displayName.value
  nameDialog.value = true
}

function saveName() {
  if (disabled.value || !nameDialog.value) return
  if (!validName(nameForm.value)) {
    ElMessage.warning(t.value.tripNameRequired)
    return
  }
  tripName.value = nameForm.value.trim()
  nameDialog.value = false
}

function openPlace(index: number) {
  if (disabled.value || !Number.isInteger(index)) return
  const place = places.value[index]
  if (!place) return
  placeForm.name = place.name
  placeForm.stayMinutes = place.stayMinutes
  placeForm.departureTime = index === 0 && startTime.value ? new Date(startTime.value) : null
  placeDialogIndex.value = index
}

function savePlace() {
  const index = placeDialogIndex.value
  if (disabled.value || index === null || !places.value[index]) return
  if (!validName(placeForm.name)) {
    ElMessage.warning(t.value.nameRequired)
    return
  }
  if (index === 0 && !validStart(placeForm.departureTime)) {
    ElMessage.warning(t.value.invalidStartTime)
    return
  }
  if (isMiddle(index) && !validMinutes(placeForm.stayMinutes, 0, ITINERARY_MAX_STAY_MINUTES)) {
    ElMessage.warning(t.value.stayInvalid)
    return
  }
  places.value[index].name = placeForm.name.trim()
  if (index === 0) startTime.value = new Date(placeForm.departureTime!)
  else if (isMiddle(index)) places.value[index].stayMinutes = placeForm.stayMinutes
  placeDialogIndex.value = null
}

function openLeg(index: number) {
  if (disabled.value || !Number.isInteger(index)) return
  const leg = legs.value[index]
  if (!leg) return
  legForm.mode = leg.mode
  legForm.durationMinutes = leg.durationMinutes
  legDialogIndex.value = index
}

function saveLeg() {
  const index = legDialogIndex.value
  if (disabled.value || index === null || !legs.value[index]) return
  if (
    !TRANSPORT_MODES.some((mode) => mode.value === legForm.mode) ||
    !validMinutes(legForm.durationMinutes, 1, ITINERARY_MAX_DURATION_MINUTES)
  ) {
    ElMessage.warning(t.value.durationInvalid)
    return
  }
  legs.value[index] = { mode: legForm.mode, durationMinutes: legForm.durationMinutes }
  legDialogIndex.value = null
}

function addMiddle() {
  if (disabled.value) return
  if (places.value.length >= ITINERARY_MAX_PLACES) {
    ElMessage.warning(t.value.placeLimit)
    return
  }
  if (!legs.value.length) return
  addForm.name = t.value.newPlace
  addForm.stayMinutes = 0
  addForm.legIndex = legs.value.length - 1
  addDialog.value = true
}

function saveMiddle() {
  if (disabled.value || !addDialog.value) return
  if (places.value.length >= ITINERARY_MAX_PLACES) {
    ElMessage.warning(t.value.placeLimit)
    return
  }
  if (!validName(addForm.name)) {
    ElMessage.warning(t.value.nameRequired)
    return
  }
  if (!validMinutes(addForm.stayMinutes, 0, ITINERARY_MAX_STAY_MINUTES)) {
    ElMessage.warning(t.value.stayInvalid)
    return
  }
  const index = addForm.legIndex
  if (!Number.isInteger(index) || index < 0 || index >= legs.value.length) return
  const source = legs.value[index]
  places.value.splice(index + 1, 0, { name: addForm.name.trim(), stayMinutes: addForm.stayMinutes })
  legs.value.splice(index, 1, { ...source }, { mode: source.mode, durationMinutes: 30 })
  addDialog.value = false
}

function removeMiddle(index: number) {
  if (disabled.value || !Number.isInteger(index) || !isMiddle(index)) return
  const left = legs.value[index - 1]
  const right = legs.value[index]
  const durationMinutes = left.durationMinutes + right.durationMinutes
  if (!validMinutes(durationMinutes, 1, ITINERARY_MAX_DURATION_MINUTES)) {
    ElMessage.warning(t.value.mergeDurationInvalid)
    return
  }
  legs.value.splice(index - 1, 2, { mode: left.mode, durationMinutes })
  places.value.splice(index, 1)
  placeDialogIndex.value = null
}

async function confirmLeave() {
  const operation = operations.capture()
  if (!operation.isActive() || busy.value) return false
  confirming.value = true
  try {
    await ElMessageBox.confirm(t.value.unsavedConfirm, t.value.unsavedTitle, {
      type: 'warning',
      confirmButtonText: t.value.discardChanges,
      cancelButtonText: i18nStore.t.close.cancel,
      closeOnClickModal: false
    })
    if (!operation.isActive()) return false
    return true
  } catch {
    if (!operation.isActive()) return false
    return false
  } finally {
    if (operation.isActive()) confirming.value = false
  }
}

async function back() {
  const operation = operations.capture()
  if (!operation.isActive() || busy.value) return
  const target = isEdit.value ? `/trips/${itineraryId.value}` : '/trips'
  const confirmed = await confirmLeave()
  if (!operation.isActive() || !confirmed) return
  navigationTarget.value = target
  navigating.value = true
  try {
    await router.push(target)
    if (!operation.isActive()) return
  } finally {
    if (operation.isActive()) {
      navigationTarget.value = null
      navigating.value = false
    }
  }
}

async function guardNavigation(to: { path: string; fullPath: string }) {
  const operation = operations.capture()
  // Session expiry or explicit sign-out must not be blocked by an edit confirmation.
  if (to.path === '/login' || !operation.isActive()) return true
  if (navigationTarget.value === to.fullPath) return true
  if (confirming.value || navigating.value) return false
  if (!dirty.value) return true
  const confirmed = await confirmLeave()
  if (!operation.isActive()) return false
  return confirmed
}

onBeforeRouteLeave(guardNavigation)
onBeforeRouteUpdate(guardNavigation)

watch(itineraryId, () => {
  if (!operations.capture().isActive()) return
  nameDialog.value = false
  placeDialogIndex.value = null
  legDialogIndex.value = null
  addDialog.value = false
  tripName.value = ''
  startTime.value = null
  places.value = []
  legs.value = []
  baseline.value = null
  saving.value = false
  confirming.value = false
  navigating.value = false
  navigationTarget.value = null
  void load()
})

async function load() {
  const id = itineraryId.value
  if (id === null) return
  const operation = operations.capture()
  if (!operation.isActive()) return
  loading.value = true
  try {
    const res = await operation.call(() => window.api.getItinerary(id))
    if (!operation.isActive() || !res) return
    if (!res.success || !res.data) {
      ElMessage.error(res.message || t.value.notFound)
      await router.replace('/trips')
      if (!operation.isActive()) return
      return
    }
    tripName.value = res.data.name
    startTime.value = res.data.startTime ? new Date(res.data.startTime) : null
    places.value = res.data.places.map((place) => ({
      name: place.name,
      stayMinutes: place.stayMinutes
    }))
    legs.value = res.data.legs.map((leg) => ({
      mode: leg.mode,
      durationMinutes: leg.durationMinutes
    }))
    baseline.value = snapshot()
  } catch {
    if (!operation.isActive()) return
    ElMessage.error(t.value.loadFail)
    await router.replace('/trips')
    if (!operation.isActive()) return
  } finally {
    if (operation.isActive()) loading.value = false
  }
}

function validate() {
  if (!validStart(startTime.value)) return t.value.invalidStartTime
  if (!validName(displayName.value)) return t.value.tripNameRequired
  if (places.value.length < ITINERARY_MIN_PLACES || places.value.length > ITINERARY_MAX_PLACES)
    return t.value.placeLimit
  if (places.value.some((place) => !validName(place.name))) return t.value.nameRequired
  if (
    places.value.some(
      (place, index) =>
        !validMinutes(place.stayMinutes, 0, ITINERARY_MAX_STAY_MINUTES) ||
        (!isMiddle(index) && place.stayMinutes !== 0)
    )
  )
    return t.value.stayInvalid
  if (
    legs.value.length !== places.value.length - 1 ||
    legs.value.some(
      (leg) =>
        !TRANSPORT_MODES.some((mode) => mode.value === leg.mode) ||
        !validMinutes(leg.durationMinutes, 1, ITINERARY_MAX_DURATION_MINUTES)
    )
  )
    return t.value.durationInvalid
  return ''
}

function buildPayload() {
  return {
    name: displayName.value,
    startTime: startTime.value!.toISOString(),
    places: places.value.map((place) => ({
      name: place.name.trim(),
      stayMinutes: place.stayMinutes
    })),
    legs: legs.value.map((leg) => ({ mode: leg.mode, durationMinutes: leg.durationMinutes }))
  }
}

async function save() {
  if (disabled.value) return
  const error = validate()
  if (error) {
    ElMessage.warning(error)
    return
  }
  const operation = operations.capture()
  if (!operation.isActive()) return
  saving.value = true
  try {
    const payload = buildPayload()
    const res = await operation.call(() =>
      isEdit.value
        ? window.api.updateItinerary({ itineraryId: itineraryId.value!, ...payload })
        : window.api.createItinerary(payload)
    )
    if (!operation.isActive() || !res) return
    if (!res.success || !res.data) {
      ElMessage.error(res.message || t.value.saveFail)
      return
    }
    ElMessage.success(t.value.saveSuccess)
    const target = `/trips/${res.data.id}`
    navigationTarget.value = target
    await router.replace(target)
    if (!operation.isActive()) return
  } catch {
    if (operation.isActive()) ElMessage.error(t.value.saveFail)
  } finally {
    if (operation.isActive()) {
      saving.value = false
      navigationTarget.value = null
    }
  }
}

onMounted(() => {
  if (isEdit.value) void load()
  else {
    places.value = [
      { name: t.value.start, stayMinutes: 0 },
      { name: t.value.end, stayMinutes: 0 }
    ]
    legs.value = [{ mode: 'car', durationMinutes: 30 }]
    baseline.value = snapshot()
  }
})
</script>

<template>
  <div class="page-container">
    <header class="page-head trip-editor-head">
      <div class="min-w-0">
        <button
          type="button"
          class="back-link"
          :disabled="disabled"
          data-testid="back-button"
          @click="back"
        >
          <span class="i-ep-back" aria-hidden="true"></span>
          {{ isEdit ? t.backToDisplay : t.backToList }}
        </button>
        <h1 class="page-head-title">
          <button
            type="button"
            class="name-button"
            :title="t.editName"
            :aria-label="t.editName"
            :disabled="disabled"
            data-testid="name-button"
            @click="openName"
          >
            {{ displayName }}
          </button>
        </h1>
        <p class="page-subtitle" data-testid="diagram-subtitle">{{ subtitle }}</p>
      </div>
      <button
        type="button"
        class="btn-secondary add-middle"
        :disabled="disabled || places.length >= ITINERARY_MAX_PLACES"
        data-testid="add-middle-button"
        @click="addMiddle"
      >
        <span class="i-ep-circle-plus" aria-hidden="true"></span>
        {{ t.addMiddle }}
      </button>
    </header>

    <el-skeleton v-if="loading" :rows="8" animated />
    <div v-else class="flex flex-col gap-5">
      <TripDiagram
        :start-time="startTime"
        :places="places"
        :legs="legs"
        editable
        :disabled="disabled"
        @edit-place="openPlace"
        @edit-leg="openLeg"
      />
      <div class="flex gap-3">
        <button type="button" class="btn-secondary" :disabled="disabled" @click="back">
          {{ i18nStore.t.close.cancel }}
        </button>
        <button
          type="button"
          class="btn-primary"
          :disabled="disabled"
          :aria-busy="saving"
          data-testid="save-button"
          @click="save"
        >
          <span v-if="saving" class="i-ep-loading animate-spin" aria-hidden="true"></span>
          {{ saving ? t.saving : t.save }}
        </button>
      </div>
    </div>

    <el-dialog v-model="nameDialog" :title="t.editName" width="min(420px, 92vw)" append-to-body>
      <el-form
        label-position="top"
        class="custom-form"
        :disabled="disabled"
        @submit.prevent="saveName"
      >
        <el-form-item :label="t.name">
          <el-input
            v-model="nameForm"
            :maxlength="ITINERARY_NAME_MAX_LENGTH"
            :placeholder="t.namePlaceholder"
            data-testid="name-input"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="flex gap-3">
          <button
            type="button"
            class="btn-secondary"
            :disabled="disabled"
            @click="nameDialog = false"
          >
            {{ i18nStore.t.close.cancel }}
          </button>
          <button
            type="button"
            class="btn-primary"
            :disabled="disabled"
            data-testid="confirm-name"
            @click="saveName"
          >
            {{ t.confirm }}
          </button>
        </div>
      </template>
    </el-dialog>

    <el-dialog
      :model-value="placeDialogIndex !== null"
      :title="placeDialogTitle"
      width="min(420px, 92vw)"
      append-to-body
      @close="placeDialogIndex = null"
    >
      <el-form
        label-position="top"
        class="custom-form"
        :disabled="disabled"
        @submit.prevent="savePlace"
      >
        <el-form-item :label="t.name">
          <el-input
            v-model="placeForm.name"
            :maxlength="ITINERARY_NAME_MAX_LENGTH"
            data-testid="place-name-input"
          />
        </el-form-item>
        <el-form-item v-if="placeDialogIndex === 0" :label="t.startTime">
          <el-date-picker
            v-model="placeForm.departureTime"
            type="datetime"
            class="w-full"
            :placeholder="t.startTime"
            data-testid="departure-input"
          />
        </el-form-item>
        <el-form-item
          v-else-if="placeDialogIndex !== null && isMiddle(placeDialogIndex)"
          :label="t.stay"
        >
          <el-input-number
            v-model="placeForm.stayMinutes"
            :min="0"
            :max="ITINERARY_MAX_STAY_MINUTES"
            :step="1"
            class="w-full"
            data-testid="stay-input"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="flex flex-wrap gap-3">
          <button
            v-if="placeDialogIndex !== null && isMiddle(placeDialogIndex)"
            type="button"
            class="btn-secondary"
            :disabled="disabled"
            data-testid="remove-middle"
            @click="removeMiddle(placeDialogIndex)"
          >
            {{ t.removePlace }}
          </button>
          <button
            type="button"
            class="btn-secondary"
            :disabled="disabled"
            @click="placeDialogIndex = null"
          >
            {{ i18nStore.t.close.cancel }}
          </button>
          <button
            type="button"
            class="btn-primary"
            :disabled="disabled"
            data-testid="confirm-place"
            @click="savePlace"
          >
            {{ t.confirm }}
          </button>
        </div>
      </template>
    </el-dialog>

    <el-dialog
      :model-value="legDialogIndex !== null"
      :title="t.editMode"
      width="min(420px, 92vw)"
      append-to-body
      @close="legDialogIndex = null"
    >
      <el-form
        label-position="top"
        class="custom-form"
        :disabled="disabled"
        @submit.prevent="saveLeg"
      >
        <el-form-item :label="t.mode">
          <el-select v-model="legForm.mode" class="w-full" data-testid="mode-input">
            <el-option
              v-for="opt in modeOptions"
              :key="opt.value"
              :label="opt.label"
              :value="opt.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item :label="t.duration">
          <el-input-number
            v-model="legForm.durationMinutes"
            :min="1"
            :max="ITINERARY_MAX_DURATION_MINUTES"
            :step="1"
            class="w-full"
            data-testid="duration-input"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="flex gap-3">
          <button
            type="button"
            class="btn-secondary"
            :disabled="disabled"
            @click="legDialogIndex = null"
          >
            {{ i18nStore.t.close.cancel }}
          </button>
          <button
            type="button"
            class="btn-primary"
            :disabled="disabled"
            data-testid="confirm-leg"
            @click="saveLeg"
          >
            {{ t.confirm }}
          </button>
        </div>
      </template>
    </el-dialog>

    <el-dialog
      v-model="addDialog"
      :title="t.addMiddleTitle"
      width="min(420px, 92vw)"
      append-to-body
    >
      <el-form
        label-position="top"
        class="custom-form"
        :disabled="disabled"
        @submit.prevent="saveMiddle"
      >
        <el-form-item :label="t.name">
          <el-input
            v-model="addForm.name"
            :maxlength="ITINERARY_NAME_MAX_LENGTH"
            data-testid="new-place-input"
          />
        </el-form-item>
        <el-form-item :label="t.stay">
          <el-input-number
            v-model="addForm.stayMinutes"
            :min="0"
            :max="ITINERARY_MAX_STAY_MINUTES"
            :step="1"
            class="w-full"
            data-testid="new-stay-input"
          />
        </el-form-item>
        <el-form-item :label="t.insertBetween">
          <el-select v-model="addForm.legIndex" class="w-full" data-testid="insert-input">
            <el-option
              v-for="(_, index) in legs"
              :key="index"
              :value="index"
              :label="`${places[index].name} → ${places[index + 1].name}`"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="flex gap-3">
          <button
            type="button"
            class="btn-secondary"
            :disabled="disabled"
            @click="addDialog = false"
          >
            {{ i18nStore.t.close.cancel }}
          </button>
          <button
            type="button"
            class="btn-primary"
            :disabled="disabled"
            data-testid="confirm-middle"
            @click="saveMiddle"
          >
            {{ t.confirm }}
          </button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.trip-editor-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}

.back-link,
.name-button {
  border: 0;
  background: transparent;
  padding: 0;
  cursor: pointer;
}

.name-button {
  color: inherit;
  font: inherit;
  text-align: left;
  overflow-wrap: anywhere;
  transition: color 0.16s ease;
}

.name-button:hover:not(:disabled) {
  color: #2d629e;
}

button:disabled {
  cursor: not-allowed;
}
</style>
