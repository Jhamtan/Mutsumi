/** User identity lives only in this renderer's memory; disk cache is never used to restore authentication. */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { UserDTO } from '@common/types'
import { useNotebookStore } from './notebook'

export interface RendererSessionSnapshot {
  revision: number
  userId: number | null
}
export type SessionSyncResult = 'authenticated' | 'unauthenticated' | 'unavailable' | 'stale'

const STORAGE_KEY = 'auth:user'

function clearLegacyUser(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Even if storage is unavailable, stay signed out without blocking logout.
  }
}

export const useUserStore = defineStore('user', () => {
  clearLegacyUser()
  const notebooks = useNotebookStore()
  const currentUser = ref<UserDTO | null>(null)
  const sessionRevision = ref(0)
  const authenticationPending = ref(false)
  const logoutPending = ref(false)
  const isLoggedIn = computed(() => currentUser.value !== null)
  let synchronization: { revision: number; promise: Promise<SessionSyncResult> } | undefined

  function assignUser(user: UserDTO): void {
    currentUser.value = {
      id: user.id,
      name: user.name,
      email: user.email,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    }
  }

  function clearIdentity(): void {
    currentUser.value = null
    notebooks.reset()
    clearLegacyUser()
  }

  function captureSession(): RendererSessionSnapshot {
    return { revision: sessionRevision.value, userId: currentUser.value?.id ?? null }
  }

  function matchesSession(snapshot: RendererSessionSnapshot): boolean {
    return (
      snapshot.revision === sessionRevision.value &&
      snapshot.userId === (currentUser.value?.id ?? null) &&
      !authenticationPending.value &&
      !logoutPending.value
    )
  }

  function setUser(user: UserDTO): void {
    sessionRevision.value++
    authenticationPending.value = false
    logoutPending.value = false
    notebooks.reset()
    assignUser(user)
    clearLegacyUser()
  }

  function logout(): void {
    sessionRevision.value++
    authenticationPending.value = false
    logoutPending.value = false
    clearIdentity()
  }

  function beginAuthentication(): number {
    logout()
    authenticationPending.value = true
    return sessionRevision.value
  }

  function isCurrentAuthentication(attempt: number): boolean {
    return authenticationPending.value && attempt === sessionRevision.value
  }

  function completeAuthentication(user: UserDTO, attempt: number): boolean {
    if (!isCurrentAuthentication(attempt)) return false
    assignUser(user)
    authenticationPending.value = false
    notebooks.reset()
    clearLegacyUser()
    return true
  }

  function cancelAuthentication(attempt: number): boolean {
    if (!isCurrentAuthentication(attempt)) return false
    logout()
    return true
  }

  function beginLogout(): number | undefined {
    if (logoutPending.value) return undefined
    sessionRevision.value++
    authenticationPending.value = false
    logoutPending.value = true
    return sessionRevision.value
  }

  function completeLogout(attempt: number): boolean {
    if (!logoutPending.value || attempt !== sessionRevision.value) return false
    logout()
    return true
  }

  function failLogout(attempt: number): boolean {
    if (!logoutPending.value || attempt !== sessionRevision.value) return false
    logoutPending.value = false
    sessionRevision.value++
    return true
  }

  function expireSession(snapshot: RendererSessionSnapshot): boolean {
    if (!matchesSession(snapshot)) return false
    logout()
    return true
  }

  function synchronizeFromMain(): Promise<SessionSyncResult> {
    if (authenticationPending.value || logoutPending.value) return Promise.resolve('stale')
    const snapshot = captureSession()
    if (synchronization?.revision === snapshot.revision) return synchronization.promise
    const operation: Promise<SessionSyncResult> = (async (): Promise<SessionSyncResult> => {
      if (typeof window.api?.getCurrentUser !== 'function') return 'unavailable'
      const response = await window.api.getCurrentUser()
      if (!matchesSession(snapshot)) return 'stale'
      if (
        response.success &&
        response.data &&
        Number.isSafeInteger(response.data.id) &&
        response.data.id > 0
      ) {
        if (snapshot.userId !== response.data.id) {
          sessionRevision.value++
          notebooks.reset()
        }
        assignUser(response.data)
        clearLegacyUser()
        return 'authenticated'
      }
      if (!response.success && response.code === 'AUTH_REQUIRED') {
        return expireSession(snapshot) ? 'unauthenticated' : 'stale'
      }
      // A cancelled/busy/failed lookup is not evidence that a valid session ended.
      return 'unavailable'
    })().catch(() => (matchesSession(snapshot) ? 'unavailable' : 'stale'))
    synchronization = { revision: snapshot.revision, promise: operation }
    void operation.finally(() => {
      if (synchronization?.promise === operation) synchronization = undefined
    })
    return operation
  }

  return {
    currentUser,
    isLoggedIn,
    sessionRevision,
    authenticationPending,
    logoutPending,
    captureSession,
    matchesSession,
    setUser,
    logout,
    beginAuthentication,
    isCurrentAuthentication,
    completeAuthentication,
    cancelAuthentication,
    beginLogout,
    completeLogout,
    failLogout,
    expireSession,
    synchronizeFromMain
  }
})
