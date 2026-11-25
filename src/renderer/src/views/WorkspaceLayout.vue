<script setup lang="ts">
import { useI18nStore } from '@renderer/store/i18n'
import { useUserStore } from '@renderer/store/user'

const route = useRoute()
const router = useRouter()
const i18nStore = useI18nStore()
const userStore = useUserStore()
const recoveringSession = ref(false)

async function retrySession(): Promise<void> {
  if (recoveringSession.value) return
  recoveringSession.value = true
  try {
    const status = await userStore.synchronizeFromMain()
    if (status === 'unauthenticated') {
      await router.replace({ path: '/login', query: { redirect: route.fullPath } })
    } else if (status === 'unavailable') {
      ElMessage.error(
        i18nStore.locale === 'en'
          ? 'Cannot confirm the session. Please retry.'
          : '暂时无法确认登录状态，请重试。'
      )
    }
  } finally {
    recoveringSession.value = false
  }
}

// The collapsed state persists to localStorage so the expand/collapse state is restored after restart.
const COLLAPSED_KEY = 'nav:collapsed'

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

const collapsed = ref(loadCollapsed())
const lastTripsPath = ref('/trips')

watch(
  [() => userStore.sessionRevision, () => userStore.currentUser?.id],
  () => {
    lastTripsPath.value = '/trips'
  },
  { flush: 'sync' }
)

watch(
  () => route.fullPath,
  () => {
    if (!userStore.isLoggedIn || userStore.authenticationPending || userStore.logoutPending) return
    const match = /^\/trips(?:\/(new|abandoned)|\/(\d+)(\/edit)?)?\/?$/.exec(route.path)
    if (!match) return
    if (match[2] && (!Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= 0)) return
    let expectedName = 'Trips'
    if (match[1]) {
      expectedName = match[1] === 'new' ? 'TripNew' : 'TripAbandoned'
    } else if (match[2]) {
      expectedName = match[3] ? 'TripEdit' : 'TripDetail'
    }
    const resolved = router.resolve(route.fullPath)
    if (resolved.matched.length > 0 && resolved.name === expectedName) {
      lastTripsPath.value = route.fullPath
    }
  },
  { immediate: true, flush: 'sync' }
)

const navItems = computed(() => [
  { label: i18nStore.t.nav.home, path: '/home', activeRoot: '/home', icon: 'i-ep-house' },
  {
    label: i18nStore.t.nav.trips,
    path: lastTripsPath.value,
    activeRoot: '/trips',
    icon: 'i-ep-position'
  },
  {
    label: i18nStore.t.nav.photowall,
    path: '/photowall',
    activeRoot: '/photowall',
    icon: 'i-ep-picture'
  },
  {
    label: i18nStore.t.nav.notebooks,
    path: '/notebooks',
    activeRoot: '/notebooks',
    icon: 'i-ep-notebook'
  }
])

function isActive(path: string): boolean {
  return route.path === path || (path !== '/home' && route.path.startsWith(`${path}/`))
}

function toggleCollapsed() {
  collapsed.value = !collapsed.value
  localStorage.setItem(COLLAPSED_KEY, collapsed.value ? '1' : '0')
}
</script>

<template>
  <div class="workspace flex h-full w-full">
    <aside
      class="sidebar flex shrink-0 flex-col bg-white/72 px-[14px] pb-4 pt-[22px] backdrop-blur"
      :class="{ collapsed }"
    >
      <div class="sidebar-header">
        <el-tooltip
          :content="collapsed ? i18nStore.t.nav.expand : i18nStore.t.nav.collapse"
          placement="right"
        >
          <button
            type="button"
            class="collapse-toggle"
            :aria-label="collapsed ? i18nStore.t.nav.expand : i18nStore.t.nav.collapse"
            @click="toggleCollapsed"
          >
            <span :class="collapsed ? 'i-ep-expand' : 'i-ep-fold'" aria-hidden="true"></span>
          </button>
        </el-tooltip>
      </div>

      <nav class="flex flex-col gap-1" aria-label="主导航">
        <router-link
          v-for="item in navItems"
          :key="item.activeRoot"
          :to="item.path"
          class="nav-item"
          :class="{ active: isActive(item.activeRoot) }"
          :title="collapsed ? item.label : ''"
        >
          <span :class="`${item.icon} text-lg`" aria-hidden="true"></span>
          <span v-show="!collapsed">{{ item.label }}</span>
        </router-link>
      </nav>

      <div class="mt-auto flex flex-col pt-3">
        <router-link
          to="/settings"
          class="nav-item"
          :class="{ active: isActive('/settings') }"
          :title="collapsed ? i18nStore.t.nav.settings : ''"
        >
          <span class="i-ep-setting text-lg" aria-hidden="true"></span>
          <span v-show="!collapsed">{{ i18nStore.t.nav.settings }}</span>
        </router-link>
      </div>
    </aside>

    <main class="min-w-0 flex-1 overflow-hidden">
      <router-view v-slot="{ Component }">
        <transition name="page" mode="out-in">
          <component
            :is="Component"
            v-if="userStore.isLoggedIn"
            :key="`${userStore.sessionRevision}:${route.fullPath}`"
          />
        </transition>
      </router-view>
      <div v-if="!userStore.isLoggedIn" class="session-recovery">
        <p>
          {{ i18nStore.locale === 'en' ? 'Confirming your sign-in status…' : '正在确认登录状态…' }}
        </p>
        <button
          type="button"
          class="btn-secondary"
          :disabled="recoveringSession"
          @click="retrySession"
        >
          {{ i18nStore.locale === 'en' ? 'Retry session check' : '重新确认登录状态' }}
        </button>
      </div>
    </main>
  </div>
</template>

<style scoped>
.session-recovery {
  max-width: 360px;
  margin: 64px auto;
  padding: 24px;
  text-align: center;
  color: #607780;
}
.session-recovery p {
  margin-bottom: 16px;
}
.workspace {
  background:
    radial-gradient(ellipse at 100% 0%, #e1eefc 0, transparent 50%),
    radial-gradient(ellipse at 0% 100%, #e1f5e9 0, transparent 55%), #f5f9f8;
}

.sidebar {
  width: 232px;
  transition: width 0.2s ease;
}

.sidebar.collapsed {
  width: 64px;
  padding-left: 12px;
  padding-right: 12px;
}

.sidebar-header {
  display: flex;
  min-height: 40px;
  align-items: center;
  justify-content: flex-start;
  padding-left: 4px;
  padding-bottom: 18px;
}

.sidebar.collapsed .sidebar-header {
  justify-content: center;
  padding-left: 0;
}

.collapse-toggle {
  display: inline-flex;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: #607780;
  font-size: 17px;
  cursor: pointer;
  transition:
    background-color 0.16s ease,
    color 0.16s ease;
}

.collapse-toggle:hover {
  background: #f0f7f3;
  color: #286a51;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 12px;
  color: #607780;
  font-size: 14px;
  font-weight: 500;
  text-decoration: none;
  transition:
    background-color 0.16s ease,
    color 0.16s ease;
}

.sidebar.collapsed .nav-item {
  justify-content: center;
  padding-left: 0;
  padding-right: 0;
}

.nav-item:hover {
  background: #f0f7f3;
  color: #286a51;
}

.nav-item.active {
  background: #e1f5e9;
  color: #286a51;
  font-weight: 600;
}

.page-enter-active,
.page-leave-active {
  transition:
    opacity 180ms ease,
    transform 180ms ease;
}

.page-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.page-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
