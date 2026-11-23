import type { IpcResponse, PhotoWallPhotoDTO } from '@common/types'
import {
  PHOTOWALL_MAX_IMAGES,
  PHOTOWALL_PREVIEW_PAGE_SIZE,
  PHOTOWALL_PREVIEW_MAX_BYTES
} from '@common/photowall'
import type { SessionOperation } from '@renderer/composables/useSessionOperation'

/** Reads display copies page by page. The original operation is re-checked between pages, so an old page cannot keep issuing requests under a new account. */
export async function loadPhotoWallPreview(
  operation: SessionOperation
): Promise<IpcResponse<PhotoWallPhotoDTO[]> | undefined> {
  const result: PhotoWallPhotoDTO[] = []
  const ids = new Set<number>()
  let cursor = 0
  let expectedTotal: number | undefined
  const invalid = (): IpcResponse<PhotoWallPhotoDTO[]> => ({
    success: false,
    code: 'PHOTOWALL_PREVIEW_FAILED',
    message: 'Photo wall changed or its preview could not be loaded. Please retry.'
  })
  for (let page = 0; page < Math.ceil(PHOTOWALL_MAX_IMAGES / PHOTOWALL_PREVIEW_PAGE_SIZE); page++) {
    if (!operation.isActive()) return undefined
    const response = await operation.call(() =>
      window.api.listPhotoWallPhotoPage({
        afterId: cursor,
        pageSize: PHOTOWALL_PREVIEW_PAGE_SIZE
      })
    )
    if (!operation.isActive() || !response) return undefined
    if (!response.success) return { ...response, data: undefined }
    const data = response.data
    if (
      !data ||
      !Number.isSafeInteger(data.total) ||
      data.total < 0 ||
      data.total > PHOTOWALL_MAX_IMAGES ||
      !Array.isArray(data.items) ||
      data.items.length > PHOTOWALL_PREVIEW_PAGE_SIZE
    )
      return invalid()
    if (expectedTotal !== undefined && expectedTotal !== data.total) return invalid()
    expectedTotal = data.total
    let previous = cursor
    for (const photo of data.items) {
      if (
        !Number.isSafeInteger(photo.id) ||
        photo.id <= previous ||
        ids.has(photo.id) ||
        typeof photo.dataUrl !== 'string' ||
        photo.dataUrl.length > Math.ceil(PHOTOWALL_PREVIEW_MAX_BYTES / 3) * 4 + 64 ||
        (photo.sourceHash !== undefined && !/^[a-f0-9]{64}$/.test(photo.sourceHash))
      )
        return invalid()
      previous = photo.id
      ids.add(photo.id)
      result.push(photo)
      if (result.length > data.total || result.length > PHOTOWALL_MAX_IMAGES) return invalid()
    }
    if (data.nextCursor === null)
      return result.length === data.total ? { success: true, data: result } : invalid()
    if (!data.items.length || data.nextCursor !== previous || data.nextCursor <= cursor)
      return invalid()
    cursor = data.nextCursor
  }
  return invalid()
}
