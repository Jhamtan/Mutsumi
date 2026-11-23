import { describe, expect, it, vi } from 'vitest'
import {
  clearDraftImages,
  collectDraftImages,
  migrateInlineDraftImages,
  pruneDraftImages,
  resolveDraftImage,
  saveDraftImage
} from '../../../src/renderer/src/utils/draft-image-storage'

/**
 * Tests draft image storage: reference creation/resolution, legacy inline image
 * migration, referenced-image collection, pruning, and failure containment.
 */
describe('draft image storage', () => {
  it('stores image data separately and resolves its short reference', async () => {
    const file = new File(['image'], 'sample.png', { type: 'image/png' })
    const reference = await saveDraftImage('draft', file)

    expect(reference).toMatch(/^draft-image:\/\/[a-zA-Z0-9_-]+$/)
    expect(reference).not.toContain('base64')
    expect(resolveDraftImage('draft', reference)).toMatch(/^data:image\/png;base64,/)
  })

  it('migrates legacy inline images to compact references', () => {
    const dataUrl = 'data:image/png;base64,aW1hZ2U='
    const migrated = migrateInlineDraftImages('draft', `Before\n\n![sample](${dataUrl})\n\nAfter`)

    expect(migrated).toMatch(/!\[sample\]\(draft-image:\/\/[a-zA-Z0-9_-]+\)/)
    expect(migrated).not.toContain('base64')
    const reference = migrated.match(/draft-image:\/\/[a-zA-Z0-9_-]+/)?.[0] ?? ''
    expect(resolveDraftImage('draft', reference)).toBe(dataUrl)
  })

  it('keeps a legacy inline image when migration storage fails', () => {
    const source = '![sample](data:image/png;base64,aW1hZ2U=)'
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota')
    })

    expect(migrateInlineDraftImages('draft', source)).toBe(source)
  })

  it('collects only referenced images for a database submission', async () => {
    const first = await saveDraftImage('draft', new File(['one'], 'one.png', { type: 'image/png' }))
    const second = await saveDraftImage(
      'draft',
      new File(['two'], 'two.png', { type: 'image/png' })
    )
    await saveDraftImage('other', new File(['foreign'], 'foreign.png', { type: 'image/png' }))

    const images = collectDraftImages(
      'draft',
      `![one](${first})\n\n![two](${second})\n\n![again](${first})`
    )
    // A repeated reference is collected once, and only this draft's own images are returned.
    expect(images.map((image) => image.reference)).toEqual([first, second])
    expect(images.every((image) => image.mimeType === 'image/png')).toBe(true)
    expect(() => collectDraftImages('other', `![one](${first})`)).toThrow(/missing or invalid/)
  })

  it('does not resolve malformed, foreign or unsafe image records', () => {
    // A non-image data URL and another draft's key must never be returned.
    localStorage.setItem('draft:image:safe-id', 'javascript:alert(1)')
    localStorage.setItem('other:image:safe-id', 'data:image/png;base64,aW1hZ2U=')

    expect(resolveDraftImage('draft', 'draft-image://safe-id')).toBeUndefined()
    expect(resolveDraftImage('draft', 'draft-image://../other')).toBeUndefined()
    expect(resolveDraftImage('draft', 'https://example.com/image.png')).toBeUndefined()
  })

  it('prunes unreferenced images and clears all images for one draft', () => {
    localStorage.setItem('draft:image:keep', 'data:image/png;base64,aW1hZ2U=')
    localStorage.setItem('draft:image:remove', 'data:image/png;base64,aW1hZ2U=')
    localStorage.setItem('other:image:leave', 'data:image/png;base64,aW1hZ2U=')

    expect(pruneDraftImages('draft', '![image](draft-image://keep)')).toBe(true)
    expect(localStorage.getItem('draft:image:keep')).not.toBeNull()
    expect(localStorage.getItem('draft:image:remove')).toBeNull()
    expect(clearDraftImages('draft')).toBe(true)
    expect(localStorage.getItem('draft:image:keep')).toBeNull()
    expect(localStorage.getItem('other:image:leave')).not.toBeNull()
  })

  it('contains local storage read and cleanup failures', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked')
    })
    expect(resolveDraftImage('draft', 'draft-image://safe-id')).toBeUndefined()
    vi.restoreAllMocks()

    localStorage.setItem('draft:image:safe-id', 'data:image/png;base64,aW1hZ2U=')
    vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
      throw new DOMException('blocked')
    })
    expect(pruneDraftImages('draft', '')).toBe(false)
  })

  it('contains image read and storage failures', async () => {
    const invalidFile = new File(['text'], 'sample.txt', { type: 'text/plain' })
    await expect(saveDraftImage('draft', invalidFile)).rejects.toThrow('Invalid image data')

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota')
    })
    const image = new File(['image'], 'sample.png', { type: 'image/png' })
    await expect(saveDraftImage('draft', image)).rejects.toThrow()
  })
})
