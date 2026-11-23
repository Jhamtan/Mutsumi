/**
 * Route table for the renderer. Auth pages live under the AuthLayout shell;
 * signed-in pages live under the WorkspaceLayout shell. Leaf routes are added
 * as each feature is migrated, keeping the table free of unreachable entries.
 */
import type { RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    redirect: '/home'
  },
  {
    path: '/',
    component: () => import('../views/WorkspaceLayout.vue'),
    meta: { requiresAuth: true },
    children: [
      {
        path: 'home',
        name: 'Home',
        component: () => import('../views/home/Home.vue')
      },
      {
        path: 'notebooks',
        name: 'Notebooks',
        component: () => import('../views/notebook/NotebookList.vue')
      }
      // diaries, trips, photo wall and settings children are registered as
      // each feature is migrated.
    ]
  },
  {
    path: '/',
    component: () => import('../views/AuthLayout.vue'),
    children: [
      {
        path: 'login',
        name: 'Login',
        component: () => import('../views/Login.vue'),
        meta: { guestOnly: true }
      },
      {
        path: 'register',
        name: 'Register',
        component: () => import('../views/Register.vue'),
        meta: { guestOnly: true }
      }
    ]
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/home'
  }
]

export default routes
