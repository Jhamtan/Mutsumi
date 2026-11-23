/**
 * Route table for the renderer. Auth pages live under the AuthLayout shell;
 * signed-in pages live under the WorkspaceLayout shell. Leaf routes are added
 * as each feature is migrated, keeping the table free of unreachable entries.
 */
import type { RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    redirect: '/login'
  },
  {
    path: '/',
    component: () => import('../views/AuthLayout.vue'),
    meta: { guestOnly: true },
    children: [
      // login/register children are registered with the auth feature.
    ]
  },
  {
    path: '/',
    component: () => import('../views/WorkspaceLayout.vue'),
    meta: { requiresAuth: true },
    children: [
      // signed-in children are registered as each feature is migrated.
    ]
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/login'
  }
]

export default routes
