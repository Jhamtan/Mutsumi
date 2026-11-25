import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import type { ItineraryDTO, ItinerarySummaryDTO } from '../../../src/common/itinerary'
import type { IpcResponse } from '../../../src/common/types'
import TripDetail from '../../../src/renderer/src/views/trip/TripDetail.vue'
import TripList from '../../../src/renderer/src/views/trip/TripList.vue'
import TripDiagram from '../../../src/renderer/src/components/TripDiagram.vue'
import { useUserStore } from '../../../src/renderer/src/store/user'
import { useI18nStore } from '../../../src/renderer/src/store/i18n'
import appRoutes from '../../../src/renderer/src/config/routes'

const departure = new Date(2026, 10, 25, 12, 0)
const at = (minutes: number): string =>
  new Date(departure.getTime() + minutes * 60_000).toISOString()
const itinerary: ItineraryDTO = {
  id: 9,
  uuid: '99999999-9999-4999-8999-999999999999',
  name: '成都到北京',
  startTime: at(0),
  endTime: at(210),
  createdAt: at(0),
  updatedAt: at(0),
  places: [
    {
      id: 11,
      name: '成都',
      role: 'start',
      sortOrder: 0,
      arrivalTime: null,
      departureTime: at(0),
      stayMinutes: 0
    },
    {
      id: 12,
      name: '重庆',
      role: 'middle',
      sortOrder: 1,
      arrivalTime: at(50),
      departureTime: at(90),
      stayMinutes: 40
    },
    {
      id: 13,
      name: '北京',
      role: 'end',
      sortOrder: 2,
      arrivalTime: at(210),
      departureTime: null,
      stayMinutes: 0
    }
  ],
  legs: [
    { id: 21, fromPlaceId: 11, toPlaceId: 12, mode: 'train', durationMinutes: 50, sortOrder: 0 },
    { id: 22, fromPlaceId: 12, toPlaceId: 13, mode: 'plane', durationMinutes: 120, sortOrder: 1 }
  ]
}
const summary: ItinerarySummaryDTO = {
  id: itinerary.id,
  uuid: itinerary.uuid,
  name: itinerary.name,
  startTime: itinerary.startTime,
  endTime: itinerary.endTime,
  startPlaceName: '成都',
  endPlaceName: '北京',
  placeCount: 3,
  createdAt: itinerary.createdAt,
  updatedAt: itinerary.updatedAt
}
const userData = {
  id: 31,
  name: '图示用户',
  email: 'diagram@example.test',
  createdAt: at(0),
  updatedAt: at(0)
}
let getItinerary: ReturnType<typeof vi.fn>
let listItineraries: ReturnType<typeof vi.fn>

function pendingItinerary() {
  let resolve!: (value: IpcResponse<ItineraryDTO>) => void
  const promise = new Promise<IpcResponse<ItineraryDTO>>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function mountPage(path = '/trips/9') {
  const pinia = createPinia()
  setActivePinia(pinia)
  const user = useUserStore(pinia)
  user.setUser({ ...userData })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/trips', name: 'Trips', component: TripList },
      { path: '/trips/:itineraryId', name: 'TripDetail', component: TripDetail, props: true },
      {
        path: '/trips/:itineraryId/edit',
        name: 'TripEdit',
        component: { template: '<div>Editing</div>' }
      },
      { path: '/login', name: 'Login', component: { template: '<div>Login</div>' } }
    ]
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(RouterView, {
    global: { plugins: [pinia, router], stubs: { ElSkeleton: true } }
  })
  await flushPromises()
  return { wrapper, router, user, pinia }
}
function mountDiagram(options: { disabled?: boolean; startTime?: string | null } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  return mount(TripDiagram, {
    props: {
      startTime: options.startTime === undefined ? itinerary.startTime : options.startTime,
      places: itinerary.places,
      legs: itinerary.legs,
      editable: true,
      disabled: options.disabled
    },
    global: { plugins: [pinia] }
  })
}

beforeEach(() => {
  getItinerary = vi.fn().mockResolvedValue({ success: true, data: itinerary })
  listItineraries = vi.fn().mockResolvedValue({ success: true, data: [summary] })
  vi.stubGlobal('api', {
    getItinerary,
    listItineraries,
    deleteItinerary: vi.fn().mockResolvedValue({ success: true, data: true })
  })
  vi.stubGlobal('ElMessage', { success: vi.fn(), error: vi.fn(), warning: vi.fn() })
  vi.stubGlobal('ElMessageBox', { confirm: vi.fn().mockResolvedValue('confirm') })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('TripDetail', () => {
  it('wires display, edit and static trip routes into the protected application shell', () => {
    const router = createRouter({ history: createMemoryHistory(), routes: appRoutes })
    expect(router.resolve('/trips/9').name).toBe('TripDetail')
    expect(router.resolve('/trips/9').meta.requiresAuth).toBe(true)
    expect(router.resolve('/trips/9/edit').name).toBe('TripEdit')
    expect(router.resolve('/trips/new').name).toBe('TripNew')
    expect(router.resolve('/trips/abandoned').name).toBe('TripAbandoned')
  })

  it('renders the reference itinerary with its name, date and computed clocks', async () => {
    const { wrapper } = await mountPage()
    expect(getItinerary).toHaveBeenCalledExactlyOnceWith(9)
    expect(wrapper.get('[data-testid="trip-name"]').text()).toBe('成都到北京')
    expect(wrapper.get('[data-testid="trip-subtitle"]').text()).toBe('11月25日行程图')
    expect(wrapper.get('[data-testid="departure-0"]').text()).toBe('出发 12:00')
    expect(wrapper.get('[data-testid="arrival-1"]').text()).toBe('到达 12:50')
    expect(wrapper.get('[data-testid="stay-1"]').text()).toBe('停留 40分钟')
    expect(wrapper.get('[data-testid="departure-1"]').text()).toBe('出发 13:30')
    expect(wrapper.get('[data-testid="arrival-2"]').text()).toBe('到达 15:30')
    expect(wrapper.get('[data-testid="trip-leg-0"]').text()).toContain('火车')
    expect(wrapper.get('[data-testid="trip-leg-0"]').text()).toContain('50分钟')
    expect(wrapper.get('[data-testid="trip-leg-1"]').text()).toContain('飞机')
    expect(wrapper.get('[data-testid="trip-leg-1"]').text()).toContain('2小时')
    expect(wrapper.find('[data-testid="arrival-0"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="departure-2"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="trip-diagram"]').findAll('button')).toHaveLength(0)
  })

  it.each(['click', 'keydown.enter', 'keydown.space'])(
    'opens editing from the diagram with %s',
    async (event) => {
      const { wrapper, router } = await mountPage()
      const graph = wrapper.get('[data-testid="edit-trip-diagram"]')
      expect(graph.attributes('title')).toBe('点击行程图进行编辑')
      await graph.trigger(event)
      await flushPromises()
      expect(router.currentRoute.value.path).toBe('/trips/9/edit')
    }
  )

  it('opens a selected list item as a dedicated display page', async () => {
    const { wrapper, router } = await mountPage('/trips')
    expect(wrapper.text()).toContain('11月25日行程图')
    await wrapper.get('.trip-card').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/trips/9')
    expect(wrapper.find('[data-testid="edit-trip-diagram"]').exists()).toBe(true)
  })

  it('uses the actual departure date rather than the sample date', async () => {
    getItinerary.mockResolvedValue({
      success: true,
      data: { ...itinerary, startTime: new Date(2026, 10, 26, 9).toISOString() }
    })
    const { wrapper } = await mountPage()
    expect(wrapper.get('[data-testid="trip-subtitle"]').text()).toBe('11月26日行程图')
  })

  it('does not invent dates or clocks when the departure is missing', async () => {
    getItinerary.mockResolvedValue({ success: true, data: { ...itinerary, startTime: null } })
    const { wrapper } = await mountPage()
    expect(wrapper.get('[data-testid="trip-subtitle"]').text()).toBe('行程图')
    expect(wrapper.get('[data-testid="departure-0"]').text()).toBe('出发 —')
  })

  it('reports a failed load and supports retry', async () => {
    getItinerary.mockResolvedValueOnce({ success: false, code: 'INTERNAL_ERROR' })
    const { wrapper } = await mountPage()
    expect(wrapper.find('[data-testid="edit-trip-diagram"]').exists()).toBe(false)
    await wrapper.get('[data-testid="trip-retry"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="edit-trip-diagram"]').exists()).toBe(true)
    expect(getItinerary).toHaveBeenCalledTimes(2)
  })

  it.each(['bad-id', '0', '9007199254740992'])(
    'rejects invalid identifiers without invoking IPC: %s',
    async (id) => {
      const { wrapper } = await mountPage(`/trips/${id}`)
      expect(getItinerary).not.toHaveBeenCalled()
      expect(wrapper.find('[data-testid="edit-trip-diagram"]').exists()).toBe(false)
    }
  )

  it('ignores a detail response after leaving the page', async () => {
    const pending = pendingItinerary()
    getItinerary.mockReturnValueOnce(pending.promise)
    const { wrapper, router } = await mountPage()
    await router.push('/trips')
    pending.resolve({ success: true, data: itinerary })
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/trips')
    expect(wrapper.find('[data-testid="edit-trip-diagram"]').exists()).toBe(false)
  })

  it('does not display an old account response after a new sign-in', async () => {
    const pending = pendingItinerary()
    getItinerary.mockReturnValueOnce(pending.promise)
    const { wrapper, user } = await mountPage()
    user.setUser({ ...userData, id: 32 })
    pending.resolve({ success: true, data: itinerary })
    await flushPromises()
    expect(wrapper.find('[data-testid="edit-trip-diagram"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="trip-name"]').text()).not.toBe(itinerary.name)
  })

  it('lets an expired main-process session return to login', async () => {
    getItinerary.mockResolvedValue({ success: false, code: 'AUTH_REQUIRED' })
    const { router, user } = await mountPage()
    expect(router.currentRoute.value.path).toBe('/login')
    expect(user.isLoggedIn).toBe(false)
  })
})

describe('TripDiagram', () => {
  it('provides editable start, intermediate, destination and transport regions', async () => {
    const wrapper = mountDiagram()
    expect(wrapper.get('[data-testid="trip-place-0"]').attributes('title')).toContain('编辑起点')
    expect(wrapper.get('[data-testid="trip-place-1"]').attributes('title')).toContain('编辑途经点')
    expect(wrapper.get('[data-testid="trip-place-2"]').attributes('title')).toContain('编辑终点')
    expect(wrapper.get('[data-testid="trip-leg-0"]').attributes('title')).toContain('编辑出行方式')
    await wrapper.get('[data-testid="trip-place-1"]').trigger('click')
    await wrapper.get('[data-testid="trip-leg-0"]').trigger('click')
    expect(wrapper.emitted('edit-place')).toEqual([[1]])
    expect(wrapper.emitted('edit-leg')).toEqual([[0]])
  })

  it('does not emit editing events while disabled', async () => {
    const wrapper = mountDiagram({ disabled: true })
    await wrapper.get('[data-testid="trip-place-0"]').trigger('click')
    await wrapper.get('[data-testid="trip-leg-0"]').trigger('click')
    expect(wrapper.emitted('edit-place')).toBeUndefined()
    expect(wrapper.emitted('edit-leg')).toBeUndefined()
  })

  it('keeps a next-day arrival explicit without changing the departure caption', () => {
    const wrapper = mountDiagram({ startTime: new Date(2026, 10, 25, 23, 40).toISOString() })
    expect(wrapper.get('[data-testid="arrival-1"]').text()).toContain('11月26日 00:30')
    expect(wrapper.get('[data-testid="departure-1"]').text()).toContain('11月26日 01:10')
  })

  it('localizes transport, duration and clock labels', async () => {
    const wrapper = mountDiagram()
    useI18nStore().toggleLocale()
    await flushPromises()
    expect(wrapper.get('[data-testid="trip-leg-0"]').text()).toContain('Train')
    expect(wrapper.get('[data-testid="trip-leg-0"]').text()).toContain('50 min')
    expect(wrapper.get('[data-testid="stay-1"]').text()).toBe('Stay 40 min')
  })
})
