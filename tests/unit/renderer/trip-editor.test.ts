/* eslint-disable vue/one-component-per-file -- Multiple components are isolated test fixtures. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import TripEditor from '../../../src/renderer/src/views/trip/TripEditor.vue'
import TripDiagram from '../../../src/renderer/src/components/TripDiagram.vue'
import type { IpcResponse, ItineraryDTO, UserDTO } from '../../../src/common/types'
import { TRANSPORT_MODES } from '../../../src/common/itinerary'
import { useUserStore } from '../../../src/renderer/src/store/user'
import { useI18nStore } from '../../../src/renderer/src/store/i18n'

const ElFormStub = defineComponent({
  props: { disabled: Boolean },
  setup(_props, { slots }) {
    return () => h('form', slots.default?.())
  }
})

const ElFormItemStub = defineComponent({
  props: { label: String },
  setup(props, { slots }) {
    return () => h('label', [props.label, slots.default?.()])
  }
})

// 保留弹窗正文、标题和 footer，避免 teleport 影响查询。
const ElDialogStub = defineComponent({
  props: { modelValue: { type: Boolean, default: false }, title: String },
  setup(props, { slots }) {
    return () =>
      props.modelValue
        ? h('section', { class: 'dialog-stub', role: 'dialog', 'aria-label': props.title }, [
            slots.default?.(),
            slots.footer?.()
          ])
        : null
  }
})

const ElInputStub = defineComponent({
  props: { modelValue: { type: [String, Number, Date, Object], default: null } },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () =>
      h('input', {
        value: props.modelValue,
        onInput: (event: Event) =>
          emit('update:modelValue', (event.target as HTMLInputElement).value)
      })
  }
})

const ElSelectStub = defineComponent({
  props: { modelValue: { type: [String, Number, Date, Object], default: null } },
  emits: ['update:modelValue'],
  setup(props, { slots }) {
    return () => h('select', { value: props.modelValue }, slots.default?.())
  }
})

const ElOptionStub = defineComponent({
  props: { value: { type: [String, Number], default: '' }, label: String },
  setup(props) {
    return () => h('option', { value: props.value }, props.label)
  }
})

const user: UserDTO = {
  id: 1,
  name: '测试用户',
  email: 'test@example.test',
  createdAt: '2026-11-12T09:00:00.000Z',
  updatedAt: '2026-11-12T09:00:00.000Z'
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const dto: ItineraryDTO = {
  id: 5,
  uuid: '55555555-5555-4555-8555-555555555555',
  name: '周末漫游',
  startTime: '2026-11-12T09:00:00.000Z',
  endTime: '2026-11-12T09:30:00.000Z',
  createdAt: '2026-11-12T09:00:00.000Z',
  updatedAt: '2026-11-12T09:00:00.000Z',
  places: [
    {
      id: 1,
      name: '家',
      role: 'start',
      sortOrder: 0,
      arrivalTime: null,
      departureTime: '2026-11-12T09:00:00.000Z',
      stayMinutes: 0
    },
    {
      id: 2,
      name: '公司',
      role: 'end',
      sortOrder: 1,
      arrivalTime: '2026-11-12T09:30:00.000Z',
      departureTime: null,
      stayMinutes: 0
    }
  ],
  legs: [{ id: 1, fromPlaceId: 1, toPlaceId: 2, mode: 'car', durationMinutes: 30, sortOrder: 0 }]
}

let api: {
  getItinerary: Mock<IAppApi['getItinerary']>
  createItinerary: Mock<IAppApi['createItinerary']>
  updateItinerary: Mock<IAppApi['updateItinerary']>
}
let confirm: ReturnType<typeof vi.fn>

async function mountEditor(props: { itineraryId?: string } = {}, loggedUser: UserDTO = user) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/trips', name: 'Trips', component: { template: '<div />' } },
      { path: '/trips/new', name: 'TripNew', component: TripEditor },
      { path: '/trips/:itineraryId/edit', name: 'TripEdit', component: TripEditor, props: true },
      { path: '/trips/:itineraryId', name: 'TripDetail', component: { template: '<div />' } },
      { path: '/home', name: 'Home', component: { template: '<div />' } },
      { path: '/login', name: 'Login', component: { template: '<div />' } }
    ]
  })
  await router.push(props.itineraryId ? `/trips/${props.itineraryId}/edit` : '/trips/new')
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  const session = useUserStore(pinia)
  session.setUser(loggedUser)
  // 实际挂载 RouterView，确保 beforeRouteLeave 注册在活动路由上。
  const root = mount(defineComponent({ setup: () => () => h(RouterView) }), {
    global: {
      plugins: [pinia, router],
      stubs: {
        ElDialog: ElDialogStub,
        ElSkeleton: true,
        ElDatePicker: ElInputStub,
        ElSelect: ElSelectStub,
        ElOption: ElOptionStub,
        ElInputNumber: ElInputStub,
        ElInput: ElInputStub,
        ElForm: ElFormStub,
        ElFormItem: ElFormItemStub
      }
    }
  })
  await flushPromises()
  return {
    wrapper: root.findComponent(TripEditor),
    root,
    router,
    session,
    i18n: useI18nStore(pinia)
  }
}

function diagram(wrapper: VueWrapper) {
  return wrapper.getComponent(TripDiagram)
}

async function editPlace(wrapper: VueWrapper, index: number) {
  await wrapper.get(`[data-testid="trip-place-${index}"]`).trigger('click')
  await flushPromises()
}

async function editLeg(wrapper: VueWrapper, index: number) {
  await wrapper.get(`[data-testid="trip-leg-${index}"]`).trigger('click')
  await flushPromises()
}

async function model(wrapper: VueWrapper, testId: string, value: unknown) {
  wrapper
    .getComponent<typeof ElInputStub>(`[data-testid="${testId}"]`)
    .vm.$emit('update:modelValue', value)
  await flushPromises()
}

async function addStop(wrapper: VueWrapper, name = '公园', stayMinutes = 15, legIndex?: number) {
  await wrapper.get('[data-testid="add-middle-button"]').trigger('click')
  await model(wrapper, 'new-place-input', name)
  await model(wrapper, 'new-stay-input', stayMinutes)
  if (legIndex !== undefined) await model(wrapper, 'insert-input', legIndex)
  await wrapper.get('[data-testid="confirm-middle"]').trigger('click')
}

async function rename(wrapper: VueWrapper, name = '新的行程名称') {
  await wrapper.get('[data-testid="name-button"]').trigger('click')
  await model(wrapper, 'name-input', name)
  await wrapper.get('[data-testid="confirm-name"]').trigger('click')
}

beforeEach(() => {
  vi.stubGlobal('ElMessage', { success: vi.fn(), error: vi.fn(), warning: vi.fn() })
  confirm = vi.fn().mockResolvedValue('confirm')
  vi.stubGlobal('ElMessageBox', { confirm })
  api = {
    getItinerary: vi.fn<IAppApi['getItinerary']>(),
    createItinerary: vi.fn<IAppApi['createItinerary']>(),
    updateItinerary: vi.fn<IAppApi['updateItinerary']>()
  }
  ;(window as unknown as { api: unknown }).api = api
  api.getItinerary.mockResolvedValue({ success: true, data: dto })
  api.createItinerary.mockResolvedValue({ success: true, data: { ...dto, id: 99 } })
  api.updateItinerary.mockResolvedValue({ success: true, data: dto })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('TripEditor', () => {
  it('加载名称并复用可编辑行程图，日期使用起点的本地日期', async () => {
    const date = new Date(2026, 10, 25, 23, 45)
    api.getItinerary.mockResolvedValue({
      success: true,
      data: { ...dto, startTime: date.toISOString() }
    })
    const { wrapper, i18n } = await mountEditor({ itineraryId: '5' })
    expect(api.getItinerary).toHaveBeenCalledWith(5)
    expect(wrapper.get('h1').text()).toBe(dto.name)
    expect(wrapper.get('[data-testid="name-button"]').attributes('title')).toBe(
      i18n.t.trip.editName
    )
    expect(wrapper.get('[data-testid="diagram-subtitle"]').text()).toBe('11月25日行程图')
    expect(diagram(wrapper).props('editable')).toBe(true)
    expect(diagram(wrapper).props('disabled')).toBe(false)
    expect(diagram(wrapper).props('places')).toEqual([
      { name: '家', stayMinutes: 0 },
      { name: '公司', stayMinutes: 0 }
    ])
    expect(wrapper.text()).toContain('家')
    expect(wrapper.text()).toContain('公司')
    i18n.locale = 'en'
    await flushPromises()
    expect(wrapper.get('[data-testid="diagram-subtitle"]').text()).toContain('Nov 25')
  })

  it('未命名行程使用起终点名称，名称弹窗确认仅修改本地', async () => {
    api.getItinerary.mockResolvedValue({ success: true, data: { ...dto, name: '' } })
    const { wrapper } = await mountEditor({ itineraryId: '5' })
    expect(wrapper.get('h1').text()).toBe('家 → 公司')
    await wrapper.get('[data-testid="name-button"]').trigger('click')
    await model(wrapper, 'name-input', '  修改后的名称  ')
    expect(wrapper.get('h1').text()).toBe('家 → 公司')
    await wrapper.get('[data-testid="confirm-name"]').trigger('click')
    expect(wrapper.get('h1').text()).toBe('修改后的名称')
    expect(api.updateItinerary).not.toHaveBeenCalled()
    expect(api.createItinerary).not.toHaveBeenCalled()
  })

  it.each(['', ' '.repeat(5), '名'.repeat(121)])('名称弹窗拒绝不合法名称 %s', async (name) => {
    const { wrapper } = await mountEditor()
    await rename(wrapper, name)
    expect(wrapper.find('.dialog-stub').exists()).toBe(true)
    expect(wrapper.get('h1').text()).toBe('起点 → 终点')
    expect(ElMessage.warning).toHaveBeenCalled()
    expect(api.createItinerary).not.toHaveBeenCalled()
  })

  it('起点/途经/终点区域分别打开对应编辑弹窗并仅确认本地表单', async () => {
    const { wrapper, i18n } = await mountEditor()
    await editPlace(wrapper, 0)
    expect(wrapper.get('.dialog-stub').attributes('aria-label')).toBe(i18n.t.trip.editStart)
    expect(wrapper.find('[data-testid="departure-input"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="stay-input"]').exists()).toBe(false)
    const date = new Date(2026, 10, 25, 8, 30)
    await model(wrapper, 'place-name-input', '上海')
    await model(wrapper, 'departure-input', date)
    expect(diagram(wrapper).props('places')[0].name).toBe('起点')
    await wrapper.get('[data-testid="confirm-place"]').trigger('click')
    expect(diagram(wrapper).props('startTime')).toEqual(date)
    expect(wrapper.get('h1').text()).toBe('上海 → 终点')
    await addStop(wrapper)
    await editPlace(wrapper, 1)
    expect(wrapper.get('.dialog-stub').attributes('aria-label')).toBe(i18n.t.trip.editMiddle)
    expect(wrapper.find('[data-testid="departure-input"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="stay-input"]').exists()).toBe(true)
    await model(wrapper, 'place-name-input', '杭州')
    await model(wrapper, 'stay-input', 60)
    await wrapper.get('[data-testid="confirm-place"]').trigger('click')
    await editPlace(wrapper, 2)
    expect(wrapper.get('.dialog-stub').attributes('aria-label')).toBe(i18n.t.trip.editEnd)
    expect(wrapper.find('[data-testid="stay-input"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="departure-input"]').exists()).toBe(false)
    await model(wrapper, 'place-name-input', '南京')
    await wrapper.get('[data-testid="confirm-place"]').trigger('click')
    expect(diagram(wrapper).props('places')).toEqual([
      { name: '上海', stayMinutes: 0 },
      { name: '杭州', stayMinutes: 60 },
      { name: '南京', stayMinutes: 0 }
    ])
    expect(api.createItinerary).not.toHaveBeenCalled()
  })

  it('取消地点和名称弹窗不会应用输入', async () => {
    const { wrapper } = await mountEditor()
    await editPlace(wrapper, 0)
    await model(wrapper, 'place-name-input', '未确认地点')
    await wrapper.get('.dialog-stub .btn-secondary').trigger('click')
    expect(diagram(wrapper).props('places')[0].name).toBe('起点')
    await wrapper.get('[data-testid="name-button"]').trigger('click')
    await model(wrapper, 'name-input', '未确认名称')
    await wrapper.get('.dialog-stub .btn-secondary').trigger('click')
    expect(wrapper.get('h1').text()).toBe('起点 → 终点')
  })

  it('右上角入口打开添加弹窗，默认终点前，支持选择插入段并保持数组一致', async () => {
    const { wrapper } = await mountEditor()
    expect(wrapper.findAll('[data-testid="add-middle-button"]')).toHaveLength(1)
    await wrapper.get('[data-testid="add-middle-button"]').trigger('click')
    expect(diagram(wrapper).props('places')).toHaveLength(2)
    expect(
      wrapper.getComponent<typeof ElSelectStub>('[data-testid="insert-input"]').props('modelValue')
    ).toBe(0)
    await wrapper.get('.dialog-stub .btn-secondary').trigger('click')
    await addStop(wrapper, '乙', 20)
    await wrapper.get('[data-testid="add-middle-button"]').trigger('click')
    expect(
      wrapper.getComponent<typeof ElSelectStub>('[data-testid="insert-input"]').props('modelValue')
    ).toBe(1)
    await wrapper.get('.dialog-stub .btn-secondary').trigger('click')
    await addStop(wrapper, '甲', 10, 0)
    expect(
      diagram(wrapper)
        .props('places')
        .map((place: { name: string }) => place.name)
    ).toEqual(['起点', '甲', '乙', '终点'])
    expect(diagram(wrapper).props('legs')).toHaveLength(3)
    expect(api.createItinerary).not.toHaveBeenCalled()
  })

  it('删除途经地点合并相邻耗时，并保留左段方式', async () => {
    const { wrapper } = await mountEditor()
    await addStop(wrapper)
    await editLeg(wrapper, 0)
    await model(wrapper, 'mode-input', 'train')
    await model(wrapper, 'duration-input', 50)
    await wrapper.get('[data-testid="confirm-leg"]').trigger('click')
    await editPlace(wrapper, 1)
    await wrapper.get('[data-testid="remove-middle"]').trigger('click')
    expect(diagram(wrapper).props('places')).toHaveLength(2)
    expect(diagram(wrapper).props('legs')).toEqual([{ mode: 'train', durationMinutes: 80 }])
  })

  it('合并耗时超过上限时拒绝删除，保持数组不变', async () => {
    const { wrapper, i18n } = await mountEditor()
    await addStop(wrapper)
    await editLeg(wrapper, 0)
    await model(wrapper, 'duration-input', 10080)
    await wrapper.get('[data-testid="confirm-leg"]').trigger('click')
    await editPlace(wrapper, 1)
    await wrapper.get('[data-testid="remove-middle"]').trigger('click')
    expect(ElMessage.warning).toHaveBeenCalledWith(i18n.t.trip.mergeDurationInvalid)
    expect(diagram(wrapper).props('places')).toHaveLength(3)
    expect(diagram(wrapper).props('legs')).toHaveLength(2)
    expect(wrapper.find('.dialog-stub').exists()).toBe(true)
  })

  it.each([-1, 0.5, 10081, NaN, Infinity, null])('新增停留拒绝非法整分钟 %s', async (minutes) => {
    const { wrapper } = await mountEditor()
    await wrapper.get('[data-testid="add-middle-button"]').trigger('click')
    await model(wrapper, 'new-stay-input', minutes)
    await wrapper.get('[data-testid="confirm-middle"]').trigger('click')
    expect(diagram(wrapper).props('places')).toHaveLength(2)
    expect(diagram(wrapper).props('legs')).toHaveLength(1)
    expect(ElMessage.warning).toHaveBeenCalled()
  })

  it.each([-1, 0.5, 10081, NaN, Infinity, null])('途经停留拒绝非法整分钟 %s', async (minutes) => {
    const { wrapper } = await mountEditor()
    await addStop(wrapper)
    await editPlace(wrapper, 1)
    await model(wrapper, 'stay-input', minutes)
    await wrapper.get('[data-testid="confirm-place"]').trigger('click')
    expect(diagram(wrapper).props('places')[1].stayMinutes).toBe(15)
    expect(wrapper.find('.dialog-stub').exists()).toBe(true)
    expect(ElMessage.warning).toHaveBeenCalled()
  })

  it.each([0, -1, 1.5, 10081, NaN, Infinity, null])(
    '交通耗时拒绝非法整分钟 %s',
    async (minutes) => {
      const { wrapper } = await mountEditor()
      await editLeg(wrapper, 0)
      await model(wrapper, 'duration-input', minutes)
      await wrapper.get('[data-testid="confirm-leg"]').trigger('click')
      expect(diagram(wrapper).props('legs')[0].durationMinutes).toBe(30)
      expect(wrapper.find('.dialog-stub').exists()).toBe(true)
      expect(ElMessage.warning).toHaveBeenCalled()
    }
  )

  it.each(TRANSPORT_MODES.map((mode) => mode.value))('保留合法交通方式 %s', async (mode) => {
    const { wrapper } = await mountEditor()
    await editLeg(wrapper, 0)
    expect(wrapper.findAll('option')).toHaveLength(TRANSPORT_MODES.length)
    await model(wrapper, 'mode-input', mode)
    await model(wrapper, 'duration-input', 1)
    await wrapper.get('[data-testid="confirm-leg"]').trigger('click')
    expect(diagram(wrapper).props('legs')).toEqual([{ mode, durationMinutes: 1 }])
    expect(api.createItinerary).not.toHaveBeenCalled()
  })

  it('拒绝交通枚举之外的方式', async () => {
    const { wrapper } = await mountEditor()
    await editLeg(wrapper, 0)
    await model(wrapper, 'mode-input', 'spaceship')
    await wrapper.get('[data-testid="confirm-leg"]').trigger('click')
    expect(diagram(wrapper).props('legs')[0].mode).toBe('car')
    expect(ElMessage.warning).toHaveBeenCalled()
  })

  it('允许停留和耗时上界，合并恰好上界仍可删除', async () => {
    const { wrapper } = await mountEditor()
    await addStop(wrapper, '上界地点', 10080)
    await editLeg(wrapper, 0)
    await model(wrapper, 'duration-input', 10050)
    await wrapper.get('[data-testid="confirm-leg"]').trigger('click')
    await editPlace(wrapper, 1)
    await wrapper.get('[data-testid="remove-middle"]').trigger('click')
    expect(diagram(wrapper).props('legs')).toEqual([{ mode: 'car', durationMinutes: 10080 }])
    await wrapper.get('[data-testid="save-button"]').trigger('click')
    await flushPromises()
    expect(api.createItinerary).toHaveBeenCalledTimes(1)
    expect(api.createItinerary.mock.calls[0][0].legs[0].durationMinutes).toBe(10080)
  })

  it('最多50站，到达上限禁用新增但仍可保存', async () => {
    const { wrapper } = await mountEditor()
    for (let index = 2; index < 50; index++) await addStop(wrapper, `地点${index}`, 0)
    expect(diagram(wrapper).props('places')).toHaveLength(50)
    expect(diagram(wrapper).props('legs')).toHaveLength(49)
    expect(wrapper.get('[data-testid="add-middle-button"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="add-middle-button"]').trigger('click')
    expect(wrapper.find('.dialog-stub').exists()).toBe(false)
    await wrapper.get('[data-testid="save-button"]').trigger('click')
    await flushPromises()
    expect(api.createItinerary.mock.calls[0][0].places).toHaveLength(50)
  })

  it.each([null, 'invalid'])('缺失或无效起点日期 %s 不伪造且不能保存', async (startTime) => {
    api.getItinerary.mockResolvedValue({ success: true, data: { ...dto, startTime } })
    const { wrapper, i18n } = await mountEditor({ itineraryId: '5' })
    expect(wrapper.get('[data-testid="diagram-subtitle"]').text()).toBe(
      i18n.t.trip.diagramEmptyDate
    )
    await wrapper.get('[data-testid="save-button"]').trigger('click')
    expect(api.updateItinerary).not.toHaveBeenCalled()
    expect(ElMessage.warning).toHaveBeenCalledWith(i18n.t.trip.invalidStartTime)
    await editPlace(wrapper, 0)
    await model(wrapper, 'place-name-input', '不能提前应用')
    await model(wrapper, 'departure-input', null)
    await wrapper.get('[data-testid="confirm-place"]').trigger('click')
    expect(diagram(wrapper).props('places')[0].name).toBe('家')
    await model(wrapper, 'departure-input', new Date(2026, 10, 25, 8))
    await wrapper.get('[data-testid="confirm-place"]').trigger('click')
    expect(wrapper.get('[data-testid="diagram-subtitle"]').text()).toBe('11月25日行程图')
    await wrapper.get('[data-testid="save-button"]').trigger('click')
    await flushPromises()
    expect(api.updateItinerary).toHaveBeenCalledTimes(1)
  })

  it('创建保存载荷保持地点/出行段一致，成功进入TripDetail且不自触发确认', async () => {
    const { wrapper, router } = await mountEditor()
    await addStop(wrapper)
    await wrapper.get('[data-testid="save-button"]').trigger('click')
    await flushPromises()
    expect(api.createItinerary).toHaveBeenCalledTimes(1)
    const payload = api.createItinerary.mock.calls[0][0]
    expect(payload.name).toBe('起点 → 终点')
    expect(payload.places).toEqual([
      { name: '起点', stayMinutes: 0 },
      { name: '公园', stayMinutes: 15 },
      { name: '终点', stayMinutes: 0 }
    ])
    expect(payload.legs).toEqual([
      { mode: 'car', durationMinutes: 30 },
      { mode: 'car', durationMinutes: 30 }
    ])
    expect(Number.isNaN(new Date(payload.startTime).getTime())).toBe(false)
    expect(router.currentRoute.value.name).toBe('TripDetail')
    expect(router.currentRoute.value.params.itineraryId).toBe('99')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('已有行程保存使用update原ID及精确载荷，并回展示页', async () => {
    const { wrapper, router } = await mountEditor({ itineraryId: '5' })
    await rename(wrapper, '更新名称')
    await wrapper.get('[data-testid="save-button"]').trigger('click')
    await flushPromises()
    expect(api.updateItinerary).toHaveBeenCalledWith({
      itineraryId: 5,
      name: '更新名称',
      startTime: dto.startTime,
      places: [
        { name: '家', stayMinutes: 0 },
        { name: '公司', stayMinutes: 0 }
      ],
      legs: [{ mode: 'car', durationMinutes: 30 }]
    })
    expect(api.createItinerary).not.toHaveBeenCalled()
    expect(router.currentRoute.value.fullPath).toBe('/trips/5')
    expect(confirm).not.toHaveBeenCalled()
  })

  it.each(['name', 'place', 'leg', 'middle'] as const)(
    '%s表单阻止原生提交并只确认本地编辑',
    async (kind) => {
      const { wrapper, router } = await mountEditor()
      if (kind === 'name') await wrapper.get('[data-testid="name-button"]').trigger('click')
      else if (kind === 'place') await editPlace(wrapper, 0)
      else if (kind === 'leg') await editLeg(wrapper, 0)
      else await wrapper.get('[data-testid="add-middle-button"]').trigger('click')
      const event = new Event('submit', { bubbles: true, cancelable: true })
      expect(wrapper.get('.dialog-stub form').element.dispatchEvent(event)).toBe(false)
      expect(event.defaultPrevented).toBe(true)
      await flushPromises()
      expect(wrapper.find('.dialog-stub').exists()).toBe(false)
      expect(api.createItinerary).not.toHaveBeenCalled()
      expect(router.currentRoute.value.fullPath).toBe('/trips/new')
    }
  )

  it.each([undefined, '5'])(
    '刚进入编辑点击返回也确认，取消保留，接受回正确页面（ID=%s）',
    async (itineraryId) => {
      const { wrapper, router, i18n } = await mountEditor({ itineraryId })
      const currentPath = router.currentRoute.value.fullPath
      confirm.mockRejectedValueOnce('cancel')
      await wrapper.get('[data-testid="back-button"]').trigger('click')
      await flushPromises()
      expect(confirm).toHaveBeenCalledWith(
        i18n.t.trip.unsavedConfirm,
        i18n.t.trip.unsavedTitle,
        expect.objectContaining({ cancelButtonText: i18n.t.close.cancel })
      )
      expect(router.currentRoute.value.fullPath).toBe(currentPath)
      expect(wrapper.findComponent(TripDiagram).exists()).toBe(true)
      await wrapper.get('[data-testid="back-button"]').trigger('click')
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe(itineraryId ? '/trips/5' : '/trips')
      expect(confirm).toHaveBeenCalledTimes(2)
      expect(api.createItinerary).not.toHaveBeenCalled()
      expect(api.updateItinerary).not.toHaveBeenCalled()
    }
  )

  it('dirty状态返回只确认一次，底部取消也遵循确认', async () => {
    const { wrapper, router } = await mountEditor()
    await rename(wrapper)
    await wrapper.get('.flex.gap-3 > .btn-secondary').trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(router.currentRoute.value.fullPath).toBe('/trips')
  })

  it('实际RouterView的其他导航仅dirty时确认，拒绝后保留输入', async () => {
    const clean = await mountEditor()
    await clean.router.push('/home')
    expect(clean.router.currentRoute.value.fullPath).toBe('/home')
    expect(confirm).not.toHaveBeenCalled()
    const { wrapper, router } = await mountEditor({ itineraryId: '5' })
    await rename(wrapper)
    confirm.mockRejectedValueOnce('cancel')
    await router.push('/home')
    expect(router.currentRoute.value.fullPath).toBe('/trips/5/edit')
    expect(wrapper.get('h1').text()).toBe('新的行程名称')
    expect(confirm).toHaveBeenCalledTimes(1)
    await router.push('/home')
    expect(router.currentRoute.value.fullPath).toBe('/home')
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('同一编辑路由切换ID先确认dirty，接受后加载新行程而不保留旧输入', async () => {
    const { wrapper, router } = await mountEditor({ itineraryId: '5' })
    await rename(wrapper, '旧行程修改')
    confirm.mockRejectedValueOnce('cancel')
    await router.push('/trips/6/edit')
    expect(router.currentRoute.value.fullPath).toBe('/trips/5/edit')
    expect(api.getItinerary).toHaveBeenCalledTimes(1)
    api.getItinerary.mockResolvedValue({ success: true, data: { ...dto, id: 6, name: '新行程' } })
    await router.push('/trips/6/edit')
    await flushPromises()
    expect(api.getItinerary).toHaveBeenLastCalledWith(6)
    expect(wrapper.get('h1').text()).toBe('新行程')
    await wrapper.get('[data-testid="save-button"]').trigger('click')
    await flushPromises()
    expect(api.updateItinerary.mock.calls[0][0]).toMatchObject({ itineraryId: 6, name: '新行程' })
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('同一编辑路由切换ID后旧保存结果不能覆盖新页面或导航', async () => {
    const pending = deferred<IpcResponse<ItineraryDTO>>()
    api.updateItinerary.mockReturnValue(pending.promise)
    const { wrapper, router } = await mountEditor({ itineraryId: '5' })
    await wrapper.get('[data-testid="save-button"]').trigger('click')
    api.getItinerary.mockResolvedValue({ success: true, data: { ...dto, id: 6, name: '新行程' } })
    await router.push('/trips/6/edit')
    await flushPromises()
    expect(wrapper.get('h1').text()).toBe('新行程')
    pending.resolve({ success: true, data: dto })
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/trips/6/edit')
    expect(wrapper.get('h1').text()).toBe('新行程')
    expect(diagram(wrapper).props('disabled')).toBe(false)
    expect(ElMessage.success).not.toHaveBeenCalled()
  })

  it('确认等待期间禁止重复返回、保存、弹窗确认及其他导航', async () => {
    const pending = deferred<string>()
    confirm.mockReturnValue(pending.promise)
    const { wrapper, router } = await mountEditor()
    await wrapper.get('[data-testid="name-button"]').trigger('click')
    await model(wrapper, 'name-input', '确认期间不可修改')
    await wrapper.get('[data-testid="back-button"]').trigger('click')
    await wrapper.get('[data-testid="back-button"]').trigger('click')
    await wrapper.get('[data-testid="save-button"]').trigger('click')
    await wrapper.get('[data-testid="confirm-name"]').trigger('click')
    await router.push('/home')
    expect(diagram(wrapper).props('disabled')).toBe(true)
    expect(wrapper.get('h1').text()).toBe('起点 → 终点')
    expect(api.createItinerary).not.toHaveBeenCalled()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(router.currentRoute.value.fullPath).toBe('/trips/new')
    pending.reject('cancel')
    await flushPromises()
    expect(diagram(wrapper).props('disabled')).toBe(false)
  })

  it('保存等待期间禁重复提交及相关本地修改', async () => {
    const pending = deferred<IpcResponse<ItineraryDTO>>()
    api.createItinerary.mockReturnValue(pending.promise)
    const { wrapper } = await mountEditor()
    await wrapper.get('[data-testid="name-button"]').trigger('click')
    await model(wrapper, 'name-input', '不得应用')
    await wrapper.get('[data-testid="save-button"]').trigger('click')
    await wrapper.get('[data-testid="save-button"]').trigger('click')
    await wrapper.get('[data-testid="confirm-name"]').trigger('click')
    await wrapper.get('[data-testid="add-middle-button"]').trigger('click')
    await wrapper.get('[data-testid="back-button"]').trigger('click')
    expect(diagram(wrapper).props('disabled')).toBe(true)
    expect(wrapper.get('h1').text()).toBe('起点 → 终点')
    expect(api.createItinerary).toHaveBeenCalledTimes(1)
    expect(confirm).not.toHaveBeenCalled()
    pending.resolve({ success: false, message: '测试失败' })
    await flushPromises()
    expect(diagram(wrapper).props('disabled')).toBe(false)
  })

  it.each(['页面切换', '账号变化', '同账号重新登录', '卸载'] as const)(
    '%s后迟到的创建结果不导航或显示提示',
    async (change) => {
      const pending = deferred<IpcResponse<ItineraryDTO>>()
      api.createItinerary.mockReturnValue(pending.promise)
      const { wrapper, root, router, session } = await mountEditor()
      await wrapper.get('[data-testid="save-button"]').trigger('click')
      expect(api.createItinerary).toHaveBeenCalledTimes(1)
      if (change === '页面切换') await router.push('/home')
      else if (change === '卸载') root.unmount()
      else session.setUser({ ...user, id: change === '账号变化' ? 2 : user.id })
      const path = router.currentRoute.value.fullPath
      pending.resolve({ success: true, data: { ...dto, id: 99 } })
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe(path)
      expect(api.createItinerary).toHaveBeenCalledTimes(1)
      expect(ElMessage.success).not.toHaveBeenCalled()
      expect(ElMessage.error).not.toHaveBeenCalled()
    }
  )

  it.each(['账号变化', '同账号重新登录', '登录跳转', '卸载'] as const)(
    '%s后迟到的离开确认不能导航或应用本地状态',
    async (change) => {
      const pending = deferred<string>()
      confirm.mockReturnValue(pending.promise)
      const { wrapper, root, router, session } = await mountEditor()
      await wrapper.get('[data-testid="back-button"]').trigger('click')
      if (change === '卸载') root.unmount()
      else if (change === '登录跳转') await router.push('/login')
      else session.setUser({ ...user, id: change === '账号变化' ? 2 : user.id })
      const path = router.currentRoute.value.fullPath
      pending.resolve('confirm')
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe(path)
      expect(api.createItinerary).not.toHaveBeenCalled()
      expect(ElMessage.error).not.toHaveBeenCalled()
    }
  )

  it('路由guard等待确认时退出可以进入登录页，旧确认不继续原导航', async () => {
    const pending = deferred<string>()
    confirm.mockReturnValue(pending.promise)
    const { wrapper, router, session } = await mountEditor()
    await rename(wrapper)
    const leaving = router.push('/home')
    await flushPromises()
    expect(confirm).toHaveBeenCalledTimes(1)
    session.logout()
    await router.replace('/login')
    expect(router.currentRoute.value.fullPath).toBe('/login')
    pending.resolve('confirm')
    await leaving
    expect(router.currentRoute.value.fullPath).toBe('/login')
  })

  it('当前dirty编辑保存AUTH_REQUIRED直接过guard去登录，不阻塞或误报', async () => {
    const { wrapper, router, session } = await mountEditor()
    await rename(wrapper)
    api.createItinerary.mockResolvedValue({ success: false, code: 'AUTH_REQUIRED' })
    await wrapper.get('[data-testid="save-button"]').trigger('click')
    await flushPromises()
    expect(session.isLoggedIn).toBe(false)
    expect(router.currentRoute.value.path).toBe('/login')
    expect(router.currentRoute.value.query.redirect).toBe('/trips/new')
    expect(confirm).not.toHaveBeenCalled()
    expect(ElMessage.error).not.toHaveBeenCalled()
  })

  it('已有行程加载等待期间不伪造起点日期，旧会话迟到的成功结果不应用状态', async () => {
    const pending = deferred<IpcResponse<ItineraryDTO>>()
    api.getItinerary.mockReturnValue(pending.promise)
    const { wrapper, session, i18n } = await mountEditor({ itineraryId: '5' })
    expect(wrapper.get('[data-testid="diagram-subtitle"]').text()).toBe(
      i18n.t.trip.diagramEmptyDate
    )
    session.setUser({ ...user, id: 2 })
    pending.resolve({ success: true, data: dto })
    await flushPromises()
    expect(wrapper.get('[data-testid="diagram-subtitle"]').text()).toBe(
      i18n.t.trip.diagramEmptyDate
    )
    expect(wrapper.get('h1').text()).not.toBe(dto.name)
    expect(ElMessage.error).not.toHaveBeenCalled()
  })

  it('新账号登录后旧行程加载AUTH_REQUIRED不清空身份或导航', async () => {
    const pending = deferred<IpcResponse<ItineraryDTO>>()
    api.getItinerary.mockReturnValue(pending.promise)
    const { router, session } = await mountEditor({ itineraryId: '5' })
    session.setUser({ ...user, id: 2 })
    pending.resolve({ success: false, code: 'AUTH_REQUIRED' })
    await flushPromises()
    expect(session.currentUser?.id).toBe(2)
    expect(router.currentRoute.value.fullPath).toBe('/trips/5/edit')
    expect(ElMessage.error).not.toHaveBeenCalled()
  })

  it('账号变化后旧编辑页不能向新账号创建或修改本地表单', async () => {
    const { wrapper, session } = await mountEditor()
    await wrapper.get('[data-testid="name-button"]').trigger('click')
    await model(wrapper, 'name-input', '旧输入')
    session.setUser({ ...user, id: 2 })
    await wrapper.get('[data-testid="confirm-name"]').trigger('click')
    await wrapper.get('[data-testid="save-button"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('h1').text()).toBe('起点 → 终点')
    expect(api.createItinerary).not.toHaveBeenCalled()
    expect(session.currentUser?.id).toBe(2)
    expect(ElMessage.error).not.toHaveBeenCalled()
  })

  it.each(['OPERATION_CANCELLED', 'RATE_LIMITED', 'VALIDATION_ERROR'])(
    '新用户%s保存失败不清除身份或自动重试',
    async (code) => {
      const { wrapper, router, session } = await mountEditor({}, { ...user, id: 2 })
      api.createItinerary.mockResolvedValue({ success: false, code, message: '测试失败' })
      await wrapper.get('[data-testid="save-button"]').trigger('click')
      await flushPromises()
      expect(session.currentUser?.id).toBe(2)
      expect(session.isLoggedIn).toBe(true)
      expect(router.currentRoute.value.fullPath).toBe('/trips/new')
      expect(api.createItinerary).toHaveBeenCalledTimes(1)
      expect(ElMessage.error).toHaveBeenCalledWith('测试失败')
    }
  )

  it.each(['响应失败', '异常'] as const)('加载%s可以返回列表，不触发离开确认', async (failure) => {
    if (failure === '响应失败')
      api.getItinerary.mockResolvedValue({ success: false, message: '找不到行程' })
    else api.getItinerary.mockRejectedValue(new Error('测试错误'))
    const { router } = await mountEditor({ itineraryId: '5' })
    expect(router.currentRoute.value.fullPath).toBe('/trips')
    expect(ElMessage.error).toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })
})
