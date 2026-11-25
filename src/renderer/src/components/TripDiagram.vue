<script setup lang="ts">
import type { TransportMode, TransportRole } from '@common/itinerary'
import { useI18nStore } from '@renderer/store/i18n'
import {
  computeTimes,
  formatDiagramClock,
  formatDuration,
  modeLabel
} from '@renderer/utils/itinerary'

interface DiagramPlace {
  name: string
  stayMinutes: number
}
interface DiagramLeg {
  mode: TransportMode
  durationMinutes: number
}

const props = withDefaults(
  defineProps<{
    startTime: Date | string | null
    places: readonly DiagramPlace[]
    legs: readonly DiagramLeg[]
    editable?: boolean
    disabled?: boolean
  }>(),
  { editable: false, disabled: false }
)
const emit = defineEmits<{
  (event: 'edit-place', index: number): void
  (event: 'edit-leg', index: number): void
}>()
const i18nStore = useI18nStore()
const times = computed(() => {
  if (!props.startTime || props.places.length < 2 || props.legs.length !== props.places.length - 1)
    return []
  const start = props.startTime instanceof Date ? props.startTime : new Date(props.startTime)
  if (!Number.isFinite(start.getTime())) return []
  if (props.places.some((place) => !Number.isFinite(place.stayMinutes) || place.stayMinutes < 0))
    return []
  if (props.legs.some((leg) => !Number.isFinite(leg.durationMinutes) || leg.durationMinutes <= 0))
    return []
  return computeTimes(
    start,
    props.places.map((place) => place.stayMinutes),
    props.legs.map((leg) => leg.durationMinutes)
  )
})

function roleOf(index: number): TransportRole {
  if (index === 0) return 'start'
  return index === props.places.length - 1 ? 'end' : 'middle'
}
function placeHint(index: number): string {
  const text = i18nStore.t.trip
  return roleOf(index) === 'start'
    ? text.editStart
    : roleOf(index) === 'end'
      ? text.editEnd
      : text.editMiddle
}
function clock(value: Date | null | undefined): string {
  return formatDiagramClock(value, props.startTime, i18nStore.locale)
}
function editPlace(index: number): void {
  if (props.editable && !props.disabled) emit('edit-place', index)
}
function editLeg(index: number): void {
  if (props.editable && !props.disabled) emit('edit-leg', index)
}
</script>

<template>
  <div class="diagram-scroll" data-testid="trip-diagram" :class="{ 'is-editable': editable }">
    <div class="diagram-canvas" role="group" :aria-label="i18nStore.t.trip.viewTitle">
      <template v-for="(place, index) in places" :key="index">
        <component
          :is="editable ? 'button' : 'div'"
          :type="editable ? 'button' : undefined"
          :disabled="editable ? disabled : undefined"
          class="diagram-place trip-part"
          :data-testid="`trip-place-${index}`"
          :data-role="roleOf(index)"
          :title="editable ? `${placeHint(index)}：${place.name}` : undefined"
          :aria-label="editable ? `${placeHint(index)}：${place.name}` : undefined"
          @click="editPlace(index)"
        >
          <span v-if="editable" class="edit-hint">{{ placeHint(index) }}</span>
          <span class="place-box"
            ><span class="place-name">{{ place.name || '…' }}</span></span
          >
          <span class="place-times">
            <span v-if="index > 0" class="time-row" :data-testid="`arrival-${index}`">
              {{ i18nStore.t.trip.arrival }} {{ clock(times[index]?.arrivalTime) }}
            </span>
            <span v-if="roleOf(index) === 'middle'" class="time-row" :data-testid="`stay-${index}`">
              {{ i18nStore.t.trip.stay }}
              {{ formatDuration(place.stayMinutes, i18nStore.locale) || '—' }}
            </span>
            <span
              v-if="roleOf(index) !== 'end'"
              class="time-row"
              :data-testid="`departure-${index}`"
            >
              {{ i18nStore.t.trip.departure }} {{ clock(times[index]?.departureTime) }}
            </span>
          </span>
        </component>
        <component
          :is="editable ? 'button' : 'div'"
          v-if="index < legs.length"
          :type="editable ? 'button' : undefined"
          :disabled="editable ? disabled : undefined"
          class="diagram-leg trip-part"
          :data-testid="`trip-leg-${index}`"
          :title="editable ? i18nStore.t.trip.editMode : undefined"
          :aria-label="
            editable
              ? `${i18nStore.t.trip.editMode}：${place.name} → ${places[index + 1]?.name ?? ''}`
              : undefined
          "
          @click="editLeg(index)"
        >
          <span v-if="editable" class="edit-hint">{{ i18nStore.t.trip.editMode }}</span>
          <span class="leg-mode">{{ modeLabel(legs[index].mode, i18nStore.locale) }}</span>
          <svg class="leg-arrow" viewBox="0 0 160 24" preserveAspectRatio="none" aria-hidden="true">
            <line
              x1="0"
              y1="12"
              x2="151"
              y2="12"
              stroke="currentColor"
              stroke-width="2"
              vector-effect="non-scaling-stroke"
            />
            <path d="M147 3L160 12L147 21L150 12Z" fill="currentColor" />
          </svg>
          <span class="leg-duration">{{
            formatDuration(legs[index].durationMinutes, i18nStore.locale) || '—'
          }}</span>
        </component>
      </template>
    </div>
  </div>
</template>

<style scoped>
.diagram-scroll {
  max-width: 100%;
  overflow-x: auto;
  padding: 26px 2px 10px;
  color: #233e46;
}
.diagram-canvas {
  --node-width: clamp(104px, 12vw, 152px);
  --leg-width: clamp(100px, 13vw, 204px);
  display: flex;
  width: 100%;
  min-width: max-content;
  align-items: flex-start;
}
.trip-part {
  box-sizing: border-box;
  position: relative;
  margin: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: center;
}
.diagram-place {
  display: block;
  flex: 0 0 var(--node-width);
  width: var(--node-width);
  padding: 0;
}
.place-box {
  box-sizing: border-box;
  display: flex;
  width: 100%;
  height: 104px;
  align-items: center;
  justify-content: center;
  padding: 12px;
  border: 1.5px solid #324a54;
  border-radius: 12px;
  background: #ffffff;
}
.place-name {
  display: -webkit-box;
  overflow: hidden;
  font-size: clamp(22px, 2.8vw, 32px);
  font-weight: 600;
  line-height: 1.25;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}
.place-times {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 16px;
  text-align: left;
}
.time-row {
  font-size: 14px;
  line-height: 1.5;
  white-space: nowrap;
}
.diagram-leg {
  display: flex;
  flex: 1 0 var(--leg-width);
  min-width: var(--leg-width);
  flex-direction: column;
  align-items: stretch;
  padding: 14px 12px 0;
}
.leg-mode {
  font-size: 18px;
  font-weight: 500;
  line-height: 24px;
}
.leg-arrow {
  display: block;
  width: 100%;
  height: 24px;
}
.leg-duration {
  margin-top: 4px;
  font-size: 14px;
  line-height: 24px;
}
.edit-hint {
  position: absolute;
  z-index: 1;
  top: -22px;
  left: 50%;
  padding: 3px 7px;
  border-radius: 6px;
  background: #edf5f1;
  color: #286a51;
  font-size: 11px;
  line-height: 1.4;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transform: translateX(-50%);
}
.is-editable .trip-part:not(:disabled) {
  cursor: pointer;
}
.is-editable .trip-part:hover .edit-hint,
.is-editable .trip-part:focus-visible .edit-hint {
  opacity: 1;
}
.is-editable .diagram-place:not(:disabled):hover .place-box,
.is-editable .diagram-place:focus-visible .place-box {
  border-color: #286a51;
  background: #f7fbf9;
}
.trip-part:focus-visible {
  outline: 2px solid #286a51;
  outline-offset: 5px;
}
.trip-part:disabled {
  cursor: wait;
}
</style>
