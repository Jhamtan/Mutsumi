import { describe, expect, it, vi } from 'vitest'
import { clearDraft, loadDraft, saveDraft } from '../../../src/renderer/src/utils/draft-storage'

/**
 * Tests Markdown draft persistence: save/load/clear and containment of
 * localStorage failures (quota, blocked access).
 */
describe('draft storage', () => {
  it('saves, restores and clears a Markdown draft with its images', () => {
    localStorage.setItem('draft:image:stored', 'data:image/png;base64,aW1hZ2U=')
    expect(loadDraft('draft')).toBe('')
    expect(saveDraft('draft', '# Restored')).toBe(true)
    expect(loadDraft('draft')).toBe('# Restored')
    expect(clearDraft('draft')).toBe(true)
    expect(loadDraft('draft')).toBe('')
    // Clearing a draft also removes any stored images it referenced.
    expect(localStorage.getItem('draft:image:stored')).toBeNull()
  })

  it('contains storage and quota failures', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked')
    })
    expect(loadDraft('draft')).toBe('')
    getItem.mockRestore()

    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota')
    })
    expect(saveDraft('draft', 'content')).toBe(false)
    setItem.mockRestore()

    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('blocked')
    })
    expect(clearDraft('draft')).toBe(false)
  })
})
