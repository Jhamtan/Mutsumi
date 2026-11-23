import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useNotebookStore } from '../../../src/renderer/src/store/notebook'
import type { NotebookSummaryDTO } from '../../../src/common/types'

/**
 * Tests the notebook session store: current notebook selection, unlocked-id
 * bookkeeping, locking, and reset.
 */
const notebook: NotebookSummaryDTO = {
  id: 1,
  uuid: '51b0554e-868e-45bf-aa2d-bdf74ed6436f',
  name: 'Journal',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

beforeEach(() => setActivePinia(createPinia()))

describe('useNotebookStore', () => {
  it('starts with no current notebook and no unlocked ids', () => {
    const store = useNotebookStore()
    expect(store.current).toBeNull()
    expect(store.unlockedIds).toEqual([])
    expect(store.isUnlocked(1)).toBe(false)
  })

  it('sets the current notebook and marks it unlocked', () => {
    const store = useNotebookStore()
    store.setCurrent(notebook)
    expect(store.current).toEqual(notebook)
    expect(store.isUnlocked(1)).toBe(true)
  })

  it('does not duplicate unlocked ids', () => {
    const store = useNotebookStore()
    store.markUnlocked(1)
    store.markUnlocked(1)
    expect(store.unlockedIds).toEqual([1])
  })

  it('locks a notebook and clears it if it was current', () => {
    const store = useNotebookStore()
    store.setCurrent(notebook)
    store.lockNotebook(1)
    expect(store.isUnlocked(1)).toBe(false)
    expect(store.current).toBeNull()
  })

  it('keeps other unlocked notebooks when locking one', () => {
    const store = useNotebookStore()
    store.markUnlocked(1)
    store.markUnlocked(2)
    store.lockNotebook(1)
    expect(store.isUnlocked(1)).toBe(false)
    expect(store.isUnlocked(2)).toBe(true)
  })

  it('reset clears all session state', () => {
    const store = useNotebookStore()
    store.setCurrent(notebook)
    store.markUnlocked(2)
    store.reset()
    expect(store.current).toBeNull()
    expect(store.unlockedIds).toEqual([])
  })
})
