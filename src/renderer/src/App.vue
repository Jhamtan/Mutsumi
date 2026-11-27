<script setup lang="ts">
import { useI18nStore } from '@renderer/store/i18n'
import type { UpdateStatusDTO } from '@common/types'
import CloseDialog from './components/CloseDialog.vue'

const i18nStore = useI18nStore()
let lastNotifiedVersion: string | undefined

// When an update finishes downloading, prompt once (per version) to restart and install,
// regardless of which page the user is on.
function onUpdateStatus(status: UpdateStatusDTO) {
  if (status.state !== 'downloaded') return
  if (status.version && status.version === lastNotifiedVersion) return
  lastNotifiedVersion = status.version
  const t = i18nStore.t.settings
  ElMessageBox.confirm(t.updateDownloaded.replace('{version}', status.version ?? ''), t.about, {
    confirmButtonText: t.restartInstall,
    cancelButtonText: t.later,
    type: 'info'
  })
    .then(() => window.api.installUpdate())
    .catch(() => undefined)
}

onMounted(() => {
  window.api.onUpdateStatus(onUpdateStatus)
})
</script>

<template>
  <router-view />
  <CloseDialog />
</template>

<style>
html,
body,
#app {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

html {
  color-scheme: light;
  background: #f5f9f8;
}

body {
  font-family: 'Inter', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

h1,
h2,
p {
  margin: 0;
}

button,
input {
  font: inherit;
}

button,
a {
  -webkit-tap-highlight-color: transparent;
}

button:focus-visible,
a:focus-visible {
  outline: 3px solid #79a9df;
  outline-offset: 4px;
}

::selection {
  color: #233e46;
  background: #c5ebd6;
}

* {
  scrollbar-width: thin;
  scrollbar-color: #c5d9da transparent;
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
</style>
