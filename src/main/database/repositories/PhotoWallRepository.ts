/**
 * Photo wall config repository: one record per user, located by userId.
 */
import type { Transaction } from 'sequelize'
import type { PhotoWallCreationAttributes } from '../models/photowall.model'
import { PhotoWall } from '../models/photowall.model'
import { BaseRepository } from './BaseRepository'

type QueryOptions = { transaction?: Transaction }

/** Photo wall config data access. */
export class PhotoWallRepository extends BaseRepository<PhotoWall, PhotoWallCreationAttributes> {
  constructor() {
    super(PhotoWall, ['userId', 'minImages', 'rounded'])
  }

  /** Loads the photo wall config for a user. */
  async findByUserId(userId: number, options?: QueryOptions): Promise<PhotoWall | null> {
    try {
      return await this.model.findOne({
        where: { userId },
        transaction: options?.transaction,
        logging: false
      })
    } catch (error) {
      return this.handleError(error)
    }
  }
}

export default PhotoWallRepository
