/**
 * Notebook session store: tracks the currently open (unlocked) notebook and the
 * set of notebooks unlocked this session so the UI can skip re-prompting for a
 * password. The actual data key stays in the main process; this store only
 * mirrors which notebooks the renderer believes are unlocked.
 */
import type { NotebookSummaryDTO } from '@common/types'

export const useNotebookStore = defineStore('notebook', () => {
  const current = ref<NotebookSummaryDTO | null>(null)
  const unlockedIds = ref<number[]>([])

  function isUnlocked(notebookId: number): boolean {
    return unlockedIds.value.includes(notebookId)
  }

  function markUnlocked(notebookId: number): void {
    if (!isUnlocked(notebookId)) unlockedIds.value.push(notebookId)
  }

  function setCurrent(notebook: NotebookSummaryDTO | null): void {
    current.value = notebook
    if (notebook) markUnlocked(notebook.id)
  }

  function lockNotebook(notebookId: number): void {
    unlockedIds.value = unlockedIds.value.filter((id) => id !== notebookId)
    if (current.value?.id === notebookId) current.value = null
  }

  function reset(): void {
    current.value = null
    unlockedIds.value = []
  }

  return { current, unlockedIds, isUnlocked, markUnlocked, setCurrent, lockNotebook, reset }
})
