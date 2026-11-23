<script setup lang="ts">
import { useI18nStore } from '@renderer/store/i18n'
import { useUserStore } from '@renderer/store/user'
import avatarUrl from '@renderer/assets/0.jpg'

const i18nStore = useI18nStore()
const userStore = useUserStore()
const router = useRouter()

const user = computed(() => userStore.currentUser)
const greeting = computed(() => i18nStore.t.home.greeting.replace('{name}', user.value?.name ?? ''))

function goWrite() {
  router.push('/notebooks')
}
</script>

<template>
  <div class="home-page">
    <div class="home-shell">
      <div class="app-surface p-8 rounded-3xl">
        <div class="flex items-center gap-[15px]">
          <img :src="avatarUrl" class="home-avatar" alt="" aria-hidden="true" />
          <div class="min-w-0">
            <p class="eyebrow">{{ i18nStore.t.home.eyebrow }}</p>
            <h1
              class="mt-[5px] text-[21px] font-semibold leading-[1.35] tracking-[-0.03em] break-words"
            >
              {{ greeting }}
            </h1>
            <p class="mt-1 text-xs text-ink-muted">{{ i18nStore.t.home.subtitle }}</p>
          </div>
        </div>

        <div class="mt-6 grid gap-[9px]">
          <div
            class="flex min-w-0 items-center justify-between gap-3 rounded-[13px] border border-solid border-[#e3efee] bg-[#f8fbfa] px-[13px] py-3"
          >
            <span class="shrink-0 text-[11px] text-ink-muted">{{ i18nStore.t.home.account }}</span>
            <span class="truncate text-xs font-medium">{{ user?.email }}</span>
          </div>
          <div
            class="flex min-w-0 items-center justify-between gap-3 rounded-[13px] border border-solid border-[#e3efee] bg-[#f8fbfa] px-[13px] py-3"
          >
            <span class="shrink-0 text-[11px] text-ink-muted">{{ i18nStore.t.home.status }}</span>
            <span class="inline-flex items-center gap-2 text-sm font-medium text-brand-700">
              <span class="h-2 w-2 rounded-full bg-brand-500"></span>
              {{ i18nStore.t.home.active }}
            </span>
          </div>
        </div>

        <p class="mt-[15px] text-[11px] leading-[1.65] text-ink-muted">
          {{ i18nStore.t.home.note }}
        </p>
      </div>

      <section class="home-cta-card flex flex-col justify-center rounded-3xl p-9">
        <span
          class="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-[15px] bg-white/75 text-[22px] text-brand-700"
          aria-hidden="true"
        >
          <span class="i-ep-edit-pen"></span>
        </span>
        <h2 class="text-2xl font-semibold tracking-[-0.03em]">{{ i18nStore.t.home.cta }}</h2>
        <p class="mt-1.5 text-[13px] text-ink-muted">{{ i18nStore.t.home.ctaHint }}</p>
        <button type="button" class="btn-primary mt-6 max-w-[220px]" @click="goWrite">
          {{ i18nStore.t.home.cta }}
          <span class="i-ep-right" aria-hidden="true"></span>
        </button>
      </section>
    </div>
  </div>
</template>

<style scoped>
.home-page {
  height: 100%;
  overflow-y: auto;
  padding: 36px;
}

.home-shell {
  display: grid;
  max-width: 1040px;
  grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
  align-items: stretch;
  gap: 24px;
  margin: 0 auto;
}

.home-avatar {
  display: block;
  width: 56px;
  height: 56px;
  flex-shrink: 0;
  object-fit: cover;
  border-radius: 18px;
  background: linear-gradient(140deg, #6dc29c, #538bcb);
  box-shadow: 0 10px 22px -12px rgb(45 98 158 / 45%);
}

.home-cta-card {
  background: linear-gradient(150deg, #e1f5e9 0%, #edf8f5 45%, #e1eefc 100%);
}

@media (max-width: 860px) {
  .home-page {
    padding: 24px;
  }

  .home-shell {
    grid-template-columns: 1fr;
  }
}
</style>
