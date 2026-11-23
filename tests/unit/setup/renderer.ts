import { afterEach } from 'vitest'
import { enableAutoUnmount } from '@vue/test-utils'

/**
 * Global renderer test setup: auto-unmounts Vue wrappers and resets browser
 * state (localStorage and the DOM) between tests.
 */
enableAutoUnmount(afterEach)
afterEach(() => {
  localStorage.clear()
  document.body.replaceChildren()
})
