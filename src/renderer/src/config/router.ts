/**
 * Router factory that wires hash-based history with the authentication guard.
 * A factory keeps setup testable and state isolated across hot reloads.
 */
import { createRouter, createWebHashHistory } from 'vue-router'
import type { Router, RouterHistory } from 'vue-router'
import type { Pinia } from 'pinia'

import routes from './routes'
import { useUserStore } from '@renderer/store/user'

/** Bind the guard to the same Pinia instance that the app actually renders. */
export function attachAuthenticationGuard(router: Router, pinia: Pinia): void {
  router.beforeEach(async (to) => {
    const userStore = useUserStore(pinia)
    if (to.meta.requiresAuth || (to.meta.guestOnly && !userStore.isLoggedIn)) {
      const status = await userStore.synchronizeFromMain()
      // Do not let an old navigation interrupt a newer login or logout transition.
      if (status === 'stale') return false
      if (to.meta.requiresAuth && !userStore.isLoggedIn) {
        if (status === 'unavailable' && router.currentRoute.value.matched.length > 0) return false
        return { path: '/login', query: { redirect: to.fullPath } }
      }
    }
    if (to.meta.requiresAuth && !userStore.isLoggedIn) {
      return { path: '/login', query: { redirect: to.fullPath } }
    }
    if (to.meta.guestOnly && userStore.isLoggedIn && !userStore.logoutPending) {
      return { path: '/home' }
    }
    return true
  })
}

/** Create the application router with the main-session-backed guard attached. */
export default (pinia: Pinia, history: RouterHistory = createWebHashHistory()) => {
  const router = createRouter({ history, routes })
  attachAuthenticationGuard(router, pinia)
  return router
}
