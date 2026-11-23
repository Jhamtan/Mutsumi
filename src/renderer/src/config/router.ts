/**
 * Router factory that wires hash-based history. The authentication guard is
 * attached once the user store and main-process session IPC are migrated.
 */
import { createRouter, createWebHashHistory } from 'vue-router'
import type { Router, RouterHistory } from 'vue-router'
import type { Pinia } from 'pinia'

import routes from './routes'

/** Create the application router with hash-based history. */
export default (pinia: Pinia, history: RouterHistory = createWebHashHistory()): Router => {
  void pinia
  const router = createRouter({ history, routes })
  // The authentication guard is wired here once the user store is migrated.
  return router
}
