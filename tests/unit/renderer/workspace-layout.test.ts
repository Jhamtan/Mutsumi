/* eslint-disable vue/one-component-per-file -- Route components and tooltip stubs are test fixtures. */
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, onBeforeRouteLeave, RouterView } from 'vue-router'
import { defineComponent, h, nextTick, ref } from 'vue'
import type { UserDTO } from '../../../src/common/types'
import { useUserStore } from '../../../src/renderer/src/store/user'
import WorkspaceLayout from '../../../src/renderer/src/views/WorkspaceLayout.vue'

const ElTooltipStub = defineComponent({
  setup(_, { slots }) {
    return () => h('div', { class: 'tooltip-stub' }, [slots.default?.()])
  }
})

function makeUser(id = 1): UserDTO {
  return {
    id,
    name: `User ${id}`,
    email: `user${id}@example.com`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

async function mountLayout(initialPath = '/home') {
  const pinia = createPinia()
  setActivePinia(pinia)
  const userStore = useUserStore(pinia)
  userStore.setUser(makeUser())
  const allowEditorLeave = ref(true)
  const page = (name: string) => defineComponent({ setup: () => () => h('div', name) })
  const editor = defineComponent({
    setup() {
      onBeforeRouteLeave(() => allowEditorLeave.value)
      return () => h('div', 'TripEditor')
    }
  })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/',
        component: WorkspaceLayout,
        meta: { requiresAuth: true },
        children: [
          { path: 'home', name: 'Home', component: page('Home') },
          { path: 'trips', name: 'Trips', component: page('Trips') },
          { path: 'trips/abandoned', name: 'TripAbandoned', component: page('TripAbandoned') },
          { path: 'trips/new', name: 'TripNew', component: editor },
          { path: 'trips/:itineraryId', name: 'TripDetail', component: page('TripDetail') },
          { path: 'trips/:itineraryId/edit', name: 'TripEdit', component: editor },
          { path: 'photowall', name: 'PhotoWall', component: page('PhotoWall') },
          { path: 'notebooks', name: 'Notebooks', component: page('Notebooks') },
          { path: 'settings', name: 'Settings', component: page('Settings') },
          { path: ':pathMatch(.*)*', name: 'Unknown', component: page('Unknown') }
        ]
      },
      { path: '/login', name: 'Login', component: page('Login') }
    ]
  })
  await router.push(initialPath)
  await router.isReady()
  const wrapper = mount(defineComponent({ setup: () => () => h(RouterView) }), {
    global: { plugins: [pinia, router], stubs: { ElTooltip: ElTooltipStub } }
  })
  const tripsLink = () => wrapper.get('nav a:nth-child(2)')
  return { wrapper, router, userStore, allowEditorLeave, tripsLink }
}

describe('WorkspaceLayout', () => {
  it('renders the home, notebooks and settings navigation', async () => {
    const { wrapper } = await mountLayout()
    expect(wrapper.text()).toContain('主页')
    expect(wrapper.text()).toContain('日记本')
    expect(wrapper.text()).toContain('设置')
    expect(wrapper.get('main').text()).toBe('Home')
  })

  it('collapses and expands the sidebar via the toggle', async () => {
    const { wrapper } = await mountLayout()
    const aside = wrapper.get('aside')
    const toggle = wrapper.get('.collapse-toggle')

    expect(aside.classes()).toContain('sidebar')
    expect(aside.classes()).not.toContain('collapsed')
    expect(toggle.attributes('aria-label')).toBe('收起')

    await toggle.trigger('click')
    expect(aside.classes()).toContain('collapsed')
    expect(toggle.attributes('aria-label')).toBe('展开')
    expect(localStorage.getItem('nav:collapsed')).toBe('1')

    await toggle.trigger('click')
    expect(aside.classes()).not.toContain('collapsed')
    expect(toggle.attributes('aria-label')).toBe('收起')
    expect(localStorage.getItem('nav:collapsed')).toBe('0')
  })

  it('returns to abandoned trips after visiting home', async () => {
    const { wrapper, router, tripsLink } = await mountLayout()
    await router.push('/trips/abandoned')
    await nextTick()
    expect(tripsLink().classes()).toContain('active')
    expect(wrapper.get('main').text()).toBe('TripAbandoned')
    await router.push('/home')
    await nextTick()
    expect(tripsLink().attributes('href')).toBe('/trips/abandoned')
    expect(tripsLink().classes()).not.toContain('active')

    await tripsLink().trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/trips/abandoned')
    expect(wrapper.get('main').text()).toBe('TripAbandoned')
    expect(tripsLink().classes()).toContain('active')
  })

  it.each(['/trips/new', '/trips/42', '/trips/42/edit', '/trips/9007199254740991'])(
    'remembers the supported trip page %s',
    async (path) => {
      const { router, tripsLink } = await mountLayout()
      await router.push(path)
      await nextTick()
      expect(tripsLink().attributes('href')).toBe(path)
      expect(tripsLink().classes()).toContain('active')
      await router.push('/home')
      await nextTick()
      await tripsLink().trigger('click')
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe(path)
    }
  )

  it('updates memory to the latest trip page, including the trips list', async () => {
    const { router, tripsLink } = await mountLayout('/trips/abandoned')
    for (const path of ['/trips/42', '/trips/42/edit', '/trips']) {
      await router.push(path)
      await router.push('/home')
      await nextTick()
      expect(tripsLink().attributes('href')).toBe(path)
      await tripsLink().trigger('click')
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe(path)
    }
  })

  it('keeps query and hash when remembering a trip page', async () => {
    const path = '/trips/42/edit?day=2&filter=a%20b#notes'
    const { router, tripsLink } = await mountLayout(path)
    await router.push('/home')
    await nextTick()
    expect(tripsLink().attributes('href')).toBe(path)
    await tripsLink().trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe(path)
  })

  it('uses the trips section rather than the remembered destination for active state', async () => {
    const { router, tripsLink } = await mountLayout('/trips/abandoned')
    await router.push('/trips/unknown')
    await nextTick()
    expect(tripsLink().attributes('href')).toBe('/trips/abandoned')
    expect(tripsLink().classes()).toContain('active')
    await router.push('/tripsXXX')
    await nextTick()
    expect(tripsLink().classes()).not.toContain('active')
  })

  it.each([
    '/trips/unknown',
    '/trips/42/unknown',
    '/trips/0',
    '/trips/-1/edit',
    '/trips/1.5',
    '/trips/9007199254740992',
    '/trips/9007199254740993/edit',
    '/trips/99999999999999999999999999999999999999999999',
    '/tripsXXX',
    '/trips/https://example.com'
  ])('does not remember the unsupported destination %s', async (path) => {
    const { router, tripsLink } = await mountLayout('/trips/abandoned')
    await router.push(path)
    await router.push('/home')
    await nextTick()
    expect(tripsLink().attributes('href')).toBe('/trips/abandoned')
  })

  it('only remembers trip destinations that resolve to an actual trip route', async () => {
    const { router, tripsLink } = await mountLayout('/trips/abandoned')
    router.removeRoute('TripDetail')
    await router.push('/trips/42')
    await router.push('/home')
    await nextTick()
    expect(tripsLink().attributes('href')).toBe('/trips/abandoned')
  })

  it('does not change memory when the editor cancels navigation', async () => {
    const { router, tripsLink, allowEditorLeave } = await mountLayout('/trips/42/edit')
    allowEditorLeave.value = false
    expect(await router.push('/trips/abandoned')).toBeTruthy()
    await nextTick()
    expect(router.currentRoute.value.fullPath).toBe('/trips/42/edit')
    expect(tripsLink().attributes('href')).toBe('/trips/42/edit')

    allowEditorLeave.value = true
    await router.push('/home')
    await nextTick()
    await tripsLink().trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/trips/42/edit')
  })

  it.each([1, 2])('resets trip memory for a new session of user %s', async (id) => {
    const { router, tripsLink, userStore } = await mountLayout('/trips/42/edit?day=2#notes')
    userStore.setUser(makeUser(id))
    await nextTick()
    expect(tripsLink().attributes('href')).toBe('/trips')
    expect(router.currentRoute.value.fullPath).toBe('/trips/42/edit?day=2#notes')
    await router.push('/home')
    await nextTick()
    await tripsLink().trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/trips')

    await router.push('/trips/abandoned')
    await nextTick()
    expect(tripsLink().attributes('href')).toBe('/trips/abandoned')
  })

  it('resets trip memory when the account changes without a revision change', async () => {
    const { tripsLink, userStore } = await mountLayout('/trips/abandoned')
    const revision = userStore.sessionRevision
    userStore.currentUser = makeUser(2)
    await nextTick()
    expect(userStore.sessionRevision).toBe(revision)
    expect(tripsLink().attributes('href')).toBe('/trips')
  })

  it('resets memory through logout and same-user authentication without recapturing the old route', async () => {
    const { router, tripsLink, userStore, wrapper } = await mountLayout('/trips/abandoned')
    const attempt = userStore.beginAuthentication()
    await nextTick()
    expect(tripsLink().attributes('href')).toBe('/trips')
    expect(wrapper.find('.session-recovery').exists()).toBe(true)
    expect(userStore.completeAuthentication(makeUser(), attempt)).toBe(true)
    await nextTick()
    expect(tripsLink().attributes('href')).toBe('/trips')
    await router.push('/home')
    await nextTick()
    expect(tripsLink().attributes('href')).toBe('/trips')
  })

  it('does not persist trip memory when the layout is unmounted', async () => {
    const { router, tripsLink } = await mountLayout('/trips/abandoned')
    await router.push('/login')
    await router.push('/home')
    await nextTick()
    expect(tripsLink().attributes('href')).toBe('/trips')
    expect(Object.values(localStorage)).not.toContain('/trips/abandoned')
  })

  it('keeps remembered trips and the other sidebar entries usable while collapsed', async () => {
    const { wrapper, router, tripsLink } = await mountLayout('/trips/abandoned')
    await wrapper.get('.collapse-toggle').trigger('click')
    for (const [path, title] of [
      ['/home', '主页'],
      ['/photowall', '照片墙'],
      ['/notebooks', '日记本'],
      ['/settings', '设置']
    ]) {
      const link = wrapper.get(`aside a[href="${path}"]`)
      expect(link.attributes('title')).toBe(title)
      await link.trigger('click')
      await flushPromises()
      expect(router.currentRoute.value.path).toBe(path)
      expect(link.classes()).toContain('active')
      expect(tripsLink().classes()).not.toContain('active')
    }
    await tripsLink().trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/trips/abandoned')
    expect(tripsLink().classes()).toContain('active')
    expect(wrapper.get('aside').classes()).toContain('collapsed')
  })

  it('still retries session recovery and redirects unauthenticated users to login', async () => {
    const { wrapper, router, userStore, tripsLink } = await mountLayout('/trips/abandoned')
    userStore.logout()
    await nextTick()
    expect(tripsLink().attributes('href')).toBe('/trips')
    expect(wrapper.get('main').text()).not.toContain('TripAbandoned')
    const synchronize = vi
      .spyOn(userStore, 'synchronizeFromMain')
      .mockResolvedValue('unauthenticated')
    await wrapper.get('.session-recovery button').trigger('click')
    await flushPromises()
    expect(synchronize).toHaveBeenCalledOnce()
    expect(router.currentRoute.value.path).toBe('/login')
    expect(router.currentRoute.value.query.redirect).toBe('/trips/abandoned')
  })
})
