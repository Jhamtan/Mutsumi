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
      },
      {
        path: 'notebooks/:notebookId/diaries',
        name: 'Diaries',
        component: () => import('../views/diary/DiaryList.vue'),
        props: true
      },
      {
        path: 'notebooks/:notebookId/diaries/new',
        name: 'DiaryNew',
        component: () => import('../views/diary/DiaryEditor.vue'),
        props: true
      },
      {
        path: 'notebooks/:notebookId/diaries/:diaryId',
        name: 'DiaryDetail',
        component: () => import('../views/diary/DiaryDetail.vue'),
        props: true
      },
      {
        path: 'notebooks/:notebookId/diaries/:diaryId/edit',
        name: 'DiaryEdit',
        component: () => import('../views/diary/DiaryEditor.vue'),
        props: true
      },
      {
        path: 'trips',
        name: 'Trips',
        component: () => import('../views/trip/TripList.vue')
      },
      {
        path: 'trips/new',
        name: 'TripNew',
        component: () => import('../views/trip/TripEditor.vue')
      },
      {
        path: 'trips/abandoned',
        name: 'TripAbandoned',
        component: () => import('../views/trip/TripAbandoned.vue')
      },
      {
        path: 'trips/:itineraryId',
        name: 'TripDetail',
        component: () => import('../views/trip/TripDetail.vue'),
        props: true
      },
      {
        path: 'trips/:itineraryId/edit',
        name: 'TripEdit',
        component: () => import('../views/trip/TripEditor.vue'),
        props: true
      },
      {
        path: 'photowall',
        name: 'PhotoWall',
        component: () => import('../views/photowall/PhotoWall.vue')
      },
      {
        path: 'photowall/view',
        name: 'PhotoWallView',
        component: () => import('../views/photowall/PhotoWallView.vue')
      },
      {
        path: 'settings',
        name: 'Settings',
        component: () => import('../views/Settings.vue')
      }
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
