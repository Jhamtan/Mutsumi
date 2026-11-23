/**
 * Renderer entry point: bootstraps the Vue 3 app, Pinia store and router,
 * then signals the Electron main process once the initial route is ready.
 */
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import 'virtual:uno.css'
import createRouter from './config/router'

const pinia = createPinia()
const app = createApp(App)
app.use(pinia)
const router = createRouter(pinia)
app.use(router)

app.mount('#app')

// Signal readiness from the application root so every initial route—including
// a restored authenticated /home route—can reveal the hidden Electron window.
// AuthLayout alone cannot do this because it is never mounted for signed-in users.
void router.isReady().then(() => {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.electron?.ipcRenderer?.send('vue-app-ready')
    })
  })
})
