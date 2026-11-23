import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import TripEditor from '../../../src/renderer/src/views/trip/TripEditor.vue'
import type { IpcResponse, ItineraryDTO, UserDTO } from '../../../src/common/types'
import { useUserStore } from '../../../src/renderer/src/store/user'

const ElFormStub = defineComponent({
  setup(_props, { slots }) {
    return () => h('form', slots.default?.())
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
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// 弹窗内容用自定义 stub 透传 slot，避免 teleport 到 body 后查询不到。
const ElDialogStub = defineComponent({
  props: { modelValue: { type: Boolean, default: false } },
  setup(props, { slots }) {
    return () => (props.modelValue ? h('div', { class: 'dialog-stub' }, slots.default?.()) : null)
  }
})

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

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/trips', name: 'Trips', component: { template: '<div />' } },
      { path: '/trips/:itineraryId/edit', name: 'TripEdit', component: { template: '<div />' } }
    ]
  })
}

async function mountEditor(props: { itineraryId?: string } = {}, loggedUser: UserDTO = user) {
  const router = makeRouter()
  await router.push(props.itineraryId ? `/trips/${props.itineraryId}/edit` : '/trips')
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  const session = useUserStore(pinia)
  session.setUser(loggedUser)
  const wrapper = mount(TripEditor, {
    props,
    global: {
      plugins: [pinia, router],
      stubs: {
        ElDialog: ElDialogStub,
        ElSkeleton: true,
        ElDatePicker: true,
        ElSelect: true,
        ElOption: true,
        ElInputNumber: true,
        ElInput: true,
        ElForm: ElFormStub,
        ElFormItem: true
      }
    }
  })
  await flushPromises()
  return { wrapper, router, session }
}

beforeEach(() => {
  vi.stubGlobal('ElMessage', { success: vi.fn(), error: vi.fn(), warning: vi.fn() })
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
  it('adds a middle stop, keeping place and leg counts consistent', async () => {
    const { wrapper } = await mountEditor()
    expect(wrapper.findAll('.place-card')).toHaveLength(2)
    expect(wrapper.findAll('.leg')).toHaveLength(1)

    await wrapper.get('.add-middle').trigger('click')
    expect(wrapper.findAll('.place-card')).toHaveLength(3)
    expect(wrapper.findAll('.leg')).toHaveLength(2)
  })

  it('removes a middle stop and merges the two adjacent legs', async () => {
    const { wrapper } = await mountEditor()
    await wrapper.get('.add-middle').trigger('click')
    expect(wrapper.findAll('.place-card')).toHaveLength(3)

    await wrapper.get('.place-middle .icon-btn').trigger('click')
    expect(wrapper.findAll('.place-card')).toHaveLength(2)
    expect(wrapper.findAll('.leg')).toHaveLength(1)
  })

  it('builds a create payload and navigates to the created trip on save', async () => {
    const { wrapper, router } = await mountEditor()
    await wrapper.get('.add-middle').trigger('click')
    await wrapper.get('[data-testid="save-button"]').trigger('click')
    await flushPromises()

    expect(api.createItinerary).toHaveBeenCalledTimes(1)
    const payload = api.createItinerary.mock.calls[0][0]
    expect(payload.places).toHaveLength(3)
    expect(payload.legs).toHaveLength(2)
    expect(payload.places[0].name).toBe('起点')
    expect(Number.isNaN(new Date(payload.startTime).getTime())).toBe(false)
    expect(router.currentRoute.value.name).toBe('TripEdit')
    expect(router.currentRoute.value.params.itineraryId).toBe('99')
  })

  it('loads an existing trip into the editor in edit mode', async () => {
    const { wrapper } = await mountEditor({ itineraryId: '5' })
    expect(api.getItinerary).toHaveBeenCalledWith(5)
    expect(wrapper.findAll('.place-card')).toHaveLength(2)
    expect(wrapper.text()).toContain('家')
    expect(wrapper.text()).toContain('公司')
  })

  it('基本信息表单阻止原生提交且不意外保存', async () => {
    const { wrapper, router } = await mountEditor()
    const event = new Event('submit', { bubbles: true, cancelable: true })
    expect(wrapper.get('form').element.dispatchEvent(event)).toBe(false)
    expect(event.defaultPrevented).toBe(true)
    await flushPromises()
    expect(api.createItinerary).not.toHaveBeenCalled()
    expect(router.currentRoute.value.fullPath).toBe('/trips')
  })

  it('地点表单阻止原生提交并保持确定按钮的保存语义', async () => {
    const { wrapper } = await mountEditor()
    await wrapper.get('.place-start .place-body').trigger('click')
    const event = new Event('submit', { bubbles: true, cancelable: true })
    expect(wrapper.get('.dialog-stub form').element.dispatchEvent(event)).toBe(false)
    expect(event.defaultPrevented).toBe(true)
    await flushPromises()
    expect(wrapper.find('.dialog-stub').exists()).toBe(false)
    expect(api.createItinerary).not.toHaveBeenCalled()
    expect(wrapper.findAll('.place-card')).toHaveLength(2)
  })

  it('出行段表单阻止原生提交并保存本地编辑', async () => {
    const { wrapper } = await mountEditor()
    await wrapper.get('.leg-mode').trigger('click')
    const event = new Event('submit', { bubbles: true, cancelable: true })
    expect(wrapper.get('.dialog-stub form').element.dispatchEvent(event)).toBe(false)
    expect(event.defaultPrevented).toBe(true)
    await flushPromises()
    expect(wrapper.find('.dialog-stub').exists()).toBe(false)
    expect(api.createItinerary).not.toHaveBeenCalled()
    expect(wrapper.findAll('.leg')).toHaveLength(1)
  })

  it.each(['页面切换', '账号变化', '同账号重新登录', '卸载'] as const)(
    '%s后迟到的创建结果不导航或显示提示',
    async (change) => {
      const pending = deferred<IpcResponse<ItineraryDTO>>()
      api.createItinerary.mockReturnValue(pending.promise)
      const { wrapper, router, session } = await mountEditor()
      await wrapper.get('[data-testid="save-button"]').trigger('click')
      expect(api.createItinerary).toHaveBeenCalledTimes(1)
      if (change === '页面切换') await router.push('/trips/5/edit')
      else if (change === '卸载') wrapper.unmount()
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

  it('新账号登录后旧行程加载的AUTH_REQUIRED不清空身份或导航', async () => {
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

  it('账号变化后旧编辑页不能向新账号发起创建', async () => {
    const { wrapper, session } = await mountEditor()
    session.setUser({ ...user, id: 2 })
    await wrapper.get('[data-testid="save-button"]').trigger('click')
    await flushPromises()
    expect(api.createItinerary).not.toHaveBeenCalled()
    expect(session.currentUser?.id).toBe(2)
    expect(ElMessage.error).not.toHaveBeenCalled()
  })

  it.each(['OPERATION_CANCELLED', 'RATE_LIMITED', 'VALIDATION_ERROR'])(
    '新用户的%s保存失败不清除登录身份或自动重试',
    async (code) => {
      const { wrapper, router, session } = await mountEditor({}, { ...user, id: 2 })
      api.createItinerary.mockResolvedValue({ success: false, code, message: '测试失败' })
      await wrapper.get('[data-testid="save-button"]').trigger('click')
      await flushPromises()
      expect(session.currentUser?.id).toBe(2)
      expect(session.isLoggedIn).toBe(true)
      expect(router.currentRoute.value.fullPath).toBe('/trips')
      expect(api.createItinerary).toHaveBeenCalledTimes(1)
      expect(ElMessage.error).toHaveBeenCalledWith('测试失败')
    }
  )
})
