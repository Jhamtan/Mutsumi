/**
 * localStorage-backed draft persistence with defensive reads so corrupt or
 * full storage never blocks the editor.
 */
import { clearDraftImages } from './draft-image-storage'

const DEFAULT_DRAFT = ''

/** Read a draft defensively so storage corruption never prevents page startup. */
export function loadDraft(storageKey: string): string {
  try {
    return localStorage.getItem(storageKey) ?? DEFAULT_DRAFT
  } catch {
    return DEFAULT_DRAFT
  }
}

/**
 * Persist the current draft. Callers can surface `false` as a storage warning;
 * quota errors are expected when users embed several large Data URL images.
 */
export function saveDraft(storageKey: string, content: string): boolean {
  try {
    localStorage.setItem(storageKey, content)
    return true
  } catch {
    return false
  }
}

/** Remove a submitted/discarded draft together with its separate image records. */
export function clearDraft(storageKey: string): boolean {
  try {
    localStorage.removeItem(storageKey)
    return clearDraftImages(storageKey)
  } catch {
    return false
  }
}
