import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { defineComponent, h } from 'vue'
import WorkspaceLayout from '../../../src/renderer/src/views/WorkspaceLayout.vue'

/**
 * Tests the authenticated workspace layout: sidebar navigation and the
 * collapsible sidebar toggle.
 */
// Passthrough stub so the collapse toggle (wrapped in el-tooltip) still renders.
const ElTooltipStub = defineComponent({
  setup(_, { slots }) {
    return () => h('div', { class: 'tooltip-stub' }, [slots.default?.()])
  }
})

async function mountLayout() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/home', name: 'Home', component: { template: '<div />' } },
      { path: '/trips', name: 'Trips', component: { template: '<div />' } },
      { path: '/photowall', name: 'PhotoWall', component: { template: '<div />' } },
      { path: '/notebooks', name: 'Notebooks', component: { template: '<div />' } },
      { path: '/settings', name: 'Settings', component: { template: '<div />' } }
    ]
  })
  await router.push('/home')
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(WorkspaceLayout, {
    global: { plugins: [pinia, router], stubs: { ElTooltip: ElTooltipStub } }
  })
  return { wrapper }
}

describe('WorkspaceLayout', () => {
  it('renders the home, notebooks and settings navigation', async () => {
    const { wrapper } = await mountLayout()
    expect(wrapper.text()).toContain('主页')
    expect(wrapper.text()).toContain('日记本')
    expect(wrapper.text()).toContain('设置')
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

    await toggle.trigger('click')
    expect(aside.classes()).not.toContain('collapsed')
    expect(toggle.attributes('aria-label')).toBe('收起')
  })
})
