import Store from 'electron-store'
import type { PhotoWallLimitsDTO } from '@common/photowall'
import { PHOTOWALL_IMAGE_MAX_BYTES, PHOTOWALL_TOTAL_MAX_BYTES } from '@common/photowall'
import { PhotoWallLimitsSchema } from '../ipc/schemas'
import { AppError } from '../errors'

export interface PhotoWallLimitsStore {
  get(key: string): unknown
  set(key: string, value: unknown): void
  delete(key: string): void
}

/** The account is chosen only by the main-process session; storage is created lazily so import and construction never touch the user directory. */
export default class PhotoWallLimitsService {
  constructor(private store?: PhotoWallLimitsStore) {}

  private storage(): PhotoWallLimitsStore {
    return (this.store ??= new Store({ name: 'photo-wall-limits' }))
  }

  private key(userId: number): string {
    if (!Number.isSafeInteger(userId) || userId <= 0)
      throw new AppError('Invalid user ID.', 'INVALID_INPUT')
    return `users.${userId}`
  }

  get(userId: number, guard?: () => void): PhotoWallLimitsDTO {
    guard?.()
    const key = this.key(userId)
    const stored = this.storage().get(key)
    guard?.()
    const parsed = PhotoWallLimitsSchema.safeParse(stored)
    return parsed.success
      ? parsed.data
      : { imageMaxBytes: PHOTOWALL_IMAGE_MAX_BYTES, totalMaxBytes: PHOTOWALL_TOTAL_MAX_BYTES }
  }

  set(userId: number, limits: PhotoWallLimitsDTO, guard?: () => void): PhotoWallLimitsDTO {
    guard?.()
    const key = this.key(userId)
    const parsed = PhotoWallLimitsSchema.safeParse(limits)
    if (!parsed.success) throw new AppError('Invalid photo wall limits.', 'INVALID_INPUT')
    const store = this.storage()
    const previous = store.get(key)
    guard?.()
    try {
      store.set(key, parsed.data)
      guard?.()
      return parsed.data
    } catch (error) {
      try {
        if (previous === undefined) store.delete(key)
        else store.set(key, previous)
      } catch (rollbackError) {
        // eslint-disable-next-line preserve-caught-error
        throw new AggregateError([error, rollbackError], 'Photo wall limits rollback failed.')
      }
      throw error
    }
  }
}
