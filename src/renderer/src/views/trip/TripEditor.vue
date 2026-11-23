<script setup lang="ts">
import type { TransportMode } from '@common/types'
import { TRANSPORT_MODES } from '@common/types'
import { useI18nStore } from '@renderer/store/i18n'
import { useSessionOperation } from '@renderer/composables/useSessionOperation'
import { computeTimes, formatClock, formatDuration, modeLabel } from '@renderer/utils/itinerary'

const props = defineProps<{ itineraryId?: string }>()
const router = useRouter()
const operations = useSessionOperation()
const i18nStore = useI18nStore()

const itineraryId = computed(() => (props.itineraryId ? Number(props.itineraryId) : null))
const isEdit = computed(() => itineraryId.value !== null)

const tripName = ref('')
const startTime = ref<Date>(new Date())
const places = ref<{ name: string; stayMinutes: number }[]>([])
const legs = ref<{ mode: TransportMode; durationMinutes: number }[]>([])

const loading = ref(isEdit.value)
const saving = ref(false)

// ---- Place/leg editor dialog state ----
const placeDialogIndex = ref<number | null>(null)
const placeForm = reactive({ name: '', stayMinutes: 0, departureTime: null as Date | null })
const legDialogIndex = ref<number | null>(null)
const legForm = reactive({ mode: 'car' as TransportMode, durationMinutes: 30 })

const locale = computed(() => i18nStore.locale)
const cancelLabel = computed(() => (locale.value === 'en' ? 'Cancel' : '取消'))
const okLabel = computed(() => (locale.value === 'en' ? 'OK' : '确定'))
const placeDialogTitle = computed(() => {
  const index = placeDialogIndex.value
  return index === null ? '' : roleLabel(index)
})
const modeOptions = computed(() =>
  TRANSPORT_MODES.map((m) => ({ value: m.value, label: locale.value === 'en' ? m.en : m.label }))
)

// ---- Recompute each place's times live ----
const times = computed(() => {
  if (!startTime.value) return []
  return computeTimes(
    startTime.value,
    places.value.map((p) => p.stayMinutes),
    legs.value.map((l) => l.durationMinutes)
  )
})

function roleOf(index: number): 'start' | 'middle' | 'end' {
  if (index === 0) return 'start'
  if (index === places.value.length - 1) return 'end'
  return 'middle'
}

function roleLabel(index: number): string {
  return i18nStore.t.trip[roleOf(index)]
}

// ---- Edit a place ----
function openPlace(index: number) {
  const place = places.value[index]
  placeForm.name = place.name
  placeForm.stayMinutes = place.stayMinutes
  placeForm.departureTime = index === 0 ? startTime.value : null
  placeDialogIndex.value = index
}

function savePlace() {
  const index = placeDialogIndex.value
  if (index === null) return
  if (!placeForm.name.trim()) {
    ElMessage.warning(i18nStore.t.trip.nameRequired)
    return
  }
  places.value[index].name = placeForm.name.trim()
  if (index === 0) {
    if (placeForm.departureTime) startTime.value = placeForm.departureTime
  } else if (roleOf(index) === 'middle') {
    places.value[index].stayMinutes = Math.max(0, Math.floor(placeForm.stayMinutes || 0))
  }
  placeDialogIndex.value = null
}

// ---- Edit a leg ----
function openLeg(index: number) {
  const leg = legs.value[index]
  legForm.mode = leg.mode
  legForm.durationMinutes = leg.durationMinutes
  legDialogIndex.value = index
}

function saveLeg() {
  const index = legDialogIndex.value
  if (index === null) return
  const minutes = Math.floor(legForm.durationMinutes)
  if (!Number.isFinite(minutes) || minutes < 1) {
    ElMessage.warning(i18nStore.t.trip.durationRequired)
    return
  }
  legs.value[index].mode = legForm.mode
  legs.value[index].durationMinutes = minutes
  legDialogIndex.value = null
}

// ---- Add / remove intermediate places ----
function addMiddle(legIndex: number) {
  const source = legs.value[legIndex]
  places.value.splice(legIndex + 1, 0, { name: '新地点', stayMinutes: 0 })
  legs.value.splice(
    legIndex,
    1,
    { mode: source.mode, durationMinutes: source.durationMinutes },
    {
      mode: source.mode,
      durationMinutes: 30
    }
  )
}

function removeMiddle(placeIndex: number) {
  const left = legs.value[placeIndex - 1]
  const right = legs.value[placeIndex]
  legs.value.splice(placeIndex - 1, 2, {
    mode: left.mode,
    durationMinutes: left.durationMinutes + right.durationMinutes
  })
  places.value.splice(placeIndex, 1)
}

// ---- Load / save ----
async function load() {
  const id = itineraryId.value
  if (id === null) return
  const operation = operations.capture()
  if (!operation.isActive()) return
  loading.value = true
  try {
    // Fetch the itinerary and map it into the editable reactive state.
    const res = await operation.call(() => window.api.getItinerary(id))
    if (!operation.isActive() || !res) return
    if (!res.success || !res.data) {
      ElMessage.error(res.message || i18nStore.t.trip.notFound)
      await router.replace('/trips')
      if (!operation.isActive()) return
      return
    }
    const dto = res.data
    tripName.value = dto.name
    startTime.value = dto.startTime ? new Date(dto.startTime) : new Date()
    places.value = dto.places.map((p) => ({ name: p.name, stayMinutes: p.stayMinutes }))
    legs.value = dto.legs.map((l) => ({ mode: l.mode, durationMinutes: l.durationMinutes }))
  } catch {
    if (operation.isActive()) ElMessage.error(i18nStore.t.trip.loadFail)
  } finally {
    if (operation.isActive()) loading.value = false
  }
}

function buildPayload() {
  const fallbackName = `${places.value[0]?.name ?? ''} → ${places.value[places.value.length - 1]?.name ?? ''}`
  return {
    name: tripName.value.trim() || fallbackName,
    startTime: startTime.value.toISOString(),
    places: places.value.map((p) => ({ name: p.name, stayMinutes: p.stayMinutes })),
    legs: legs.value.map((l) => ({ mode: l.mode, durationMinutes: l.durationMinutes }))
  }
}

async function save() {
  if (saving.value) return
  if (!startTime.value) {
    ElMessage.warning(i18nStore.t.trip.startTime)
    return
  }
  const operation = operations.capture()
  if (!operation.isActive()) return
  saving.value = true
  try {
    // Build the payload once, then create or update depending on edit mode.
    const payload = buildPayload()
    const res = await operation.call(() =>
      isEdit.value
        ? window.api.updateItinerary({ itineraryId: itineraryId.value!, ...payload })
        : window.api.createItinerary(payload)
    )
    if (!operation.isActive() || !res) return
    if (!res.success || !res.data) {
      ElMessage.error(res.message || i18nStore.t.trip.saveFail)
      return
    }
    ElMessage.success(i18nStore.t.trip.saveSuccess)
    // After saving, open the itinerary's edit page to show the generated full itinerary.
    await router.replace(`/trips/${res.data.id}/edit`)
    if (!operation.isActive()) return
  } catch {
    if (operation.isActive()) ElMessage.error(i18nStore.t.trip.saveFail)
  } finally {
    if (operation.isActive()) saving.value = false
  }
}

onMounted(() => {
  if (isEdit.value) void load()
  else {
    places.value = [
      { name: '起点', stayMinutes: 0 },
      { name: '终点', stayMinutes: 0 }
    ]
    legs.value = [{ mode: 'car', durationMinutes: 30 }]
  }
})
</script>

<template>
  <div class="page-container">
    <header class="page-head max-w-[720px]">
      <div>
        <router-link to="/trips" class="back-link">
          <span class="i-ep-back" aria-hidden="true"></span>
          {{ i18nStore.t.trip.title }}
        </router-link>
        <h1 class="page-head-title">
          {{ isEdit ? i18nStore.t.trip.editTitle : i18nStore.t.trip.newTitle }}
        </h1>
        <p class="page-subtitle">{{ i18nStore.t.trip.roleTip }}</p>
      </div>
    </header>

    <div v-if="loading" class="mx-auto max-w-[720px]">
      <el-skeleton :rows="8" animated />
    </div>

    <div v-else class="mx-auto flex max-w-[720px] flex-col gap-5">
      <!-- 基本信息 -->
      <div class="app-surface rounded-[18px] p-5">
        <el-form label-position="top" class="custom-form" @submit.prevent>
          <el-form-item :label="i18nStore.t.trip.name">
            <el-input
              v-model="tripName"
              maxlength="120"
              :placeholder="i18nStore.t.trip.namePlaceholder"
            />
          </el-form-item>
        </el-form>
      </div>

      <!-- 行程时间线 -->
      <div class="trip-flow">
        <template v-for="(place, i) in places" :key="i">
          <div class="app-surface place-card" :class="`place-${roleOf(i)}`">
            <span class="node-dot" aria-hidden="true"></span>
            <div class="place-head">
              <span class="role-badge">{{ roleLabel(i) }}</span>
              <button
                v-if="roleOf(i) === 'middle'"
                type="button"
                class="icon-btn"
                :aria-label="i18nStore.t.trip.removePlace"
                @click="removeMiddle(i)"
              >
                <span class="i-ep-delete" aria-hidden="true"></span>
              </button>
            </div>

            <div class="place-body" @click="openPlace(i)">
              <p class="place-name">{{ place.name || '…' }}</p>
              <div class="place-times">
                <template v-if="roleOf(i) === 'start'">
                  <span class="time-row">
                    <span class="i-ep-timer text-xs" aria-hidden="true"></span>
                    {{ i18nStore.t.trip.departure }}
                    <b>{{ formatClock(times[i]?.departureTime) }}</b>
                  </span>
                </template>
                <template v-else-if="roleOf(i) === 'middle'">
                  <span class="time-row">
                    {{ i18nStore.t.trip.arrival }}
                    <b>{{ formatClock(times[i]?.arrivalTime) }}</b>
                  </span>
                  <span v-if="place.stayMinutes > 0" class="time-row">
                    {{ i18nStore.t.trip.stay }}
                    <b>{{ formatDuration(place.stayMinutes) }}</b>
                  </span>
                  <span class="time-row">
                    {{ i18nStore.t.trip.departure }}
                    <b>{{ formatClock(times[i]?.departureTime) }}</b>
                  </span>
                </template>
                <template v-else>
                  <span class="time-row">
                    {{ i18nStore.t.trip.arrival }}
                    <b>{{ formatClock(times[i]?.arrivalTime) }}</b>
                  </span>
                </template>
              </div>
            </div>
          </div>

          <!-- 出行段：上面方式、下面耗时（左侧轨道连接相邻地点） -->
          <div v-if="i < legs.length" class="leg">
            <button type="button" class="leg-mode" @click="openLeg(i)">
              <span class="i-ep-top-right text-sm" aria-hidden="true"></span>
              {{ modeLabel(legs[i].mode, locale) }}
            </button>
            <button type="button" class="leg-duration" @click="openLeg(i)">
              {{ formatDuration(legs[i].durationMinutes) }}
            </button>
            <button type="button" class="add-middle" @click="addMiddle(i)">
              <span class="i-ep-circle-plus" aria-hidden="true"></span>
              {{ i18nStore.t.trip.addMiddle }}
            </button>
          </div>
        </template>
      </div>

      <!-- 操作 -->
      <div class="flex gap-3">
        <button
          type="button"
          class="btn-secondary"
          :disabled="saving"
          @click="router.push('/trips')"
        >
          {{ cancelLabel }}
        </button>
        <button
          type="button"
          class="btn-primary"
          :disabled="saving"
          :aria-busy="saving"
          data-testid="save-button"
          @click="save"
        >
          <span v-if="saving" class="i-ep-loading animate-spin" aria-hidden="true"></span>
          {{ saving ? i18nStore.t.trip.saving : i18nStore.t.trip.save }}
        </button>
      </div>
    </div>

    <!-- 编辑地点弹窗 -->
    <el-dialog
      :model-value="placeDialogIndex !== null"
      :title="placeDialogTitle"
      width="min(420px, 92vw)"
      append-to-body
      @close="placeDialogIndex = null"
    >
      <el-form label-position="top" class="custom-form" @submit.prevent="savePlace">
        <el-form-item :label="i18nStore.t.trip.name">
          <el-input v-model="placeForm.name" maxlength="120" />
        </el-form-item>
        <el-form-item v-if="placeDialogIndex === 0" :label="i18nStore.t.trip.startTime">
          <el-date-picker
            v-model="placeForm.departureTime"
            type="datetime"
            class="w-full"
            placeholder="选择日期和时间"
          />
        </el-form-item>
        <el-form-item
          v-else-if="placeDialogIndex !== null && roleOf(placeDialogIndex) === 'middle'"
          :label="i18nStore.t.trip.stay"
        >
          <el-input-number v-model="placeForm.stayMinutes" :min="0" :max="10080" class="w-full" />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="flex gap-3">
          <button type="button" class="btn-secondary" @click="placeDialogIndex = null">
            {{ cancelLabel }}
          </button>
          <button type="button" class="btn-primary" @click="savePlace">{{ okLabel }}</button>
        </div>
      </template>
    </el-dialog>

    <!-- 编辑出行段弹窗 -->
    <el-dialog
      :model-value="legDialogIndex !== null"
      :title="i18nStore.t.trip.mode"
      width="min(420px, 92vw)"
      append-to-body
      @close="legDialogIndex = null"
    >
      <el-form label-position="top" class="custom-form" @submit.prevent="saveLeg">
        <el-form-item :label="i18nStore.t.trip.mode">
          <el-select v-model="legForm.mode" class="w-full">
            <el-option
              v-for="opt in modeOptions"
              :key="opt.value"
              :label="opt.label"
              :value="opt.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item :label="i18nStore.t.trip.duration">
          <el-input-number v-model="legForm.durationMinutes" :min="1" :max="10080" class="w-full" />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="flex gap-3">
          <button type="button" class="btn-secondary" @click="legDialogIndex = null">
            {{ cancelLabel }}
          </button>
          <button type="button" class="btn-primary" @click="saveLeg">{{ okLabel }}</button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.trip-flow {
  --rail-x: 8px;
  position: relative;
  display: flex;
  flex-direction: column;
  padding-left: 24px;
}

/* The vertical track running the entire journey on the left side */
.trip-flow::before {
  content: '';
  position: absolute;
  left: calc(var(--rail-x) - 1px);
  top: 20px;
  bottom: 20px;
  width: 2px;
  border-radius: 1px;
  background: linear-gradient(180deg, #9cdabb 0%, #a2c6ed 55%, #c5ddf7 100%);
}

.place-card {
  position: relative;
  padding: 16px 18px;
  border-radius: 16px;
  transition:
    box-shadow 0.16s ease,
    transform 0.16s ease;
}

.place-card:hover {
  box-shadow: 0 12px 28px -18px rgb(42 83 101 / 45%);
}

/* Node dots on the track */
.node-dot {
  position: absolute;
  left: -22px;
  top: 24px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #45a77e;
  border: 2px solid #fff;
  box-shadow: 0 0 0 2px #45a77e;
}

.place-middle .node-dot {
  background: #538bcb;
  box-shadow: 0 0 0 2px #538bcb;
}

.place-end .node-dot {
  background: #a5bbb9;
  box-shadow: 0 0 0 2px #a5bbb9;
}

.place-start {
  border-left: 3px solid #45a77e;
}

.place-middle {
  border-left: 3px solid #538bcb;
}

.place-end {
  border-left: 3px solid #a5bbb9;
}

.place-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.role-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 9px;
  border-radius: 999px;
  background: #f0f7f3;
  color: #286a51;
  font-size: 11px;
  font-weight: 600;
}

.place-middle .role-badge {
  background: #eef4fc;
  color: #2d629e;
}

.place-end .role-badge {
  background: #eef2f2;
  color: #607780;
}

.icon-btn {
  display: inline-flex;
  height: 26px;
  width: 26px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #a5bbb9;
  cursor: pointer;
}

.icon-btn:hover {
  background: #fdeaea;
  color: #e54d4d;
}

.place-body {
  cursor: pointer;
}

.place-name {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  transition: color 0.16s ease;
}

.place-body:hover .place-name {
  color: #2d629e;
}

.place-times {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin-top: 8px;
}

.time-row {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #607780;
  font-size: 12px;
}

.time-row b {
  color: #233e46;
  font-weight: 600;
}

/* Travel segment */
.leg {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
  padding: 8px 0 10px;
}

.leg-mode,
.leg-duration {
  border: 0;
  background: transparent;
  cursor: pointer;
}

.leg-mode {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 11px;
  border-radius: 999px;
  background: linear-gradient(120deg, #eef4fc, #e1eefc);
  color: #2d629e;
  font-size: 12px;
  font-weight: 600;
  transition: box-shadow 0.16s ease;
}

.leg-mode:hover {
  box-shadow: 0 4px 12px -6px rgb(45 98 158 / 45%);
}

.leg-duration {
  color: #607780;
  font-size: 12px;
  padding: 0 11px;
}

.leg-duration:hover {
  color: #2d629e;
}

.add-middle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 4px;
  border: 1px dashed #c5ddf7;
  border-radius: 8px;
  background: transparent;
  color: #538bcb;
  font-size: 11px;
  cursor: pointer;
  padding: 3px 10px;
  transition:
    background-color 0.16s ease,
    border-color 0.16s ease;
}

.add-middle:hover {
  background: #eef4fc;
  border-color: #79a9df;
}
</style>
