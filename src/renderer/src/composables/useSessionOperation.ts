import { onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { Router } from 'vue-router'
import type { IpcResponse } from '@common/types'
import { useUserStore } from '@renderer/store/user'
import { useNotebookStore } from '@renderer/store/notebook'

export interface SessionOperation {
  isActive(): boolean
  call<T>(
    request: () => Promise<IpcResponse<T>>,
    notebookId?: number
  ): Promise<IpcResponse<T> | undefined>
}

/** Prevent old pages, dialogs and file readers from writing into a newer session. */
export function useSessionOperation(): { capture(): SessionOperation } {
  const route = useRoute()
  const router = useRouter()
  const user = useUserStore()
  const notebooks = useNotebookStore()
  const owner = user.captureSession()
  const pageRevision = ref(0)
  let mounted = true
  watch(
    () => route.fullPath,
    () => pageRevision.value++,
    { flush: 'sync' }
  )
  onBeforeUnmount(() => {
    mounted = false
    pageRevision.value++
  })

  function capture(): SessionOperation {
    const session = user.captureSession()
    const revision = pageRevision.value
    const redirect = route.fullPath
    const isActive = (): boolean =>
      mounted &&
      pageRevision.value === revision &&
      user.matchesSession(owner) &&
      user.matchesSession(session)

    async function call<T>(
      request: () => Promise<IpcResponse<T>>,
      notebookId?: number
    ): Promise<IpcResponse<T> | undefined> {
      if (!isActive()) return undefined
      let response: IpcResponse<T>
      try {
        response = await request()
      } catch (error) {
        if (!isActive()) return undefined
        throw error
      }
      if (!isActive()) return undefined
      if (!response.success && response.code === 'AUTH_REQUIRED') {
        if (user.expireSession(session)) {
          await router.replace({ path: '/login', query: { redirect } }).catch(() => undefined)
        }
        return undefined
      }
      if (
        !response.success &&
        response.code === 'NOTEBOOK_LOCKED' &&
        notebookId !== undefined &&
        Number.isSafeInteger(notebookId) &&
        notebookId > 0
      ) {
        notebooks.lockNotebook(notebookId)
        await router
          .replace({
            path: '/notebooks',
            query: { unlock: String(notebookId) }
          })
          .catch(() => undefined)
        return undefined
      }
      // Cancellation, rate limits and business failures never clear the account.
      return response
    }

    return { isActive, call }
  }

  return { capture }
}

/** A login redirect may only point to an existing protected in-app route. */
export function getSafeLoginRedirect(router: Router, redirect: unknown): string {
  if (
    typeof redirect !== 'string' ||
    !redirect.startsWith('/') ||
    redirect.startsWith('//') ||
    redirect.includes('\\')
  )
    return '/home'
  const target = router.resolve(redirect)
  if (
    !target.matched.some((record) => record.meta.requiresAuth) ||
    target.matched.some((record) => record.meta.guestOnly || record.path.includes('pathMatch'))
  )
    return '/home'
  return target.fullPath
}
