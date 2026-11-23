/** Photo wall image repository: queries are scoped to the parent wall, and metadata queries never load the image TEXT. */
import { Op, fn, col, cast, type Transaction } from 'sequelize'
import type { PhotoWallImageCreationAttributes } from '../models/photowall-image.model'
import { PhotoWallImage } from '../models/photowall-image.model'
import type { PhotoWallImageType } from '@common/photowall'
import { BaseRepository } from './BaseRepository'

type QueryOptions = { transaction?: Transaction }
export interface PhotoWallImageMetadata {
  id: number
  type: PhotoWallImageType
  prefix: string
  suffix: string
  length: number
}

export class PhotoWallImageRepository extends BaseRepository<
  PhotoWallImage,
  PhotoWallImageCreationAttributes
> {
  constructor() {
    super(PhotoWallImage, ['photoWallId', 'type', 'dataUrl'])
  }

  async findAllForWall(photoWallId: number, options?: QueryOptions): Promise<PhotoWallImage[]> {
    return this.findAll({
      attributes: ['id', 'photoWallId', 'type', 'dataUrl'],
      where: { photoWallId },
      order: [['id', 'ASC']],
      transaction: options?.transaction
    })
  }

  async findAllByType(
    photoWallId: number,
    type: PhotoWallImageType,
    options?: QueryOptions
  ): Promise<PhotoWallImage[]> {
    return this.findAll({
      attributes: ['id', 'photoWallId', 'type', 'dataUrl'],
      where: { photoWallId, type },
      order: [['id', 'ASC']],
      transaction: options?.transaction
    })
  }

  async findForWall(
    photoWallId: number,
    id: number,
    options?: QueryOptions
  ): Promise<PhotoWallImage | null> {
    try {
      return await this.model.findOne({
        attributes: ['id', 'photoWallId', 'type', 'dataUrl'],
        where: { id, photoWallId },
        transaction: options?.transaction,
        logging: false
      })
    } catch (error) {
      return this.handleError(error)
    }
  }

  async countForWall(
    photoWallId: number,
    type?: PhotoWallImageType,
    options?: QueryOptions
  ): Promise<number> {
    try {
      return await this.model.count({
        where: { photoWallId, ...(type ? { type } : {}) },
        transaction: options?.transaction,
        logging: false
      })
    } catch (error) {
      return this.handleError(error)
    }
  }

  /** Aggregates full stored bytes via BLOB to avoid TEXT NUL truncation; expressions and column names are fixed. */
  async measureForWall(
    photoWallId: number,
    type?: PhotoWallImageType,
    options?: QueryOptions
  ): Promise<{ count: number; characters: number; maxLength: number }> {
    try {
      const row = await this.model.findOne({
        attributes: [
          [fn('COUNT', col('id')), 'count'],
          [fn('SUM', fn('length', cast(col('data_url'), 'BLOB'))), 'characters'],
          [fn('MAX', fn('length', cast(col('data_url'), 'BLOB'))), 'maxLength']
        ],
        where: { photoWallId, ...(type ? { type } : {}) },
        transaction: options?.transaction,
        logging: false
      })
      return {
        count: Number(row?.get('count') ?? 0),
        characters: Number(row?.get('characters') ?? 0),
        maxLength: Number(row?.get('maxLength') ?? 0)
      }
    } catch (error) {
      return this.handleError(error)
    }
  }

  async metadataForWall(
    photoWallId: number,
    type?: PhotoWallImageType,
    options?: QueryOptions
  ): Promise<PhotoWallImageMetadata[]> {
    try {
      const rows = await this.model.findAll({
        attributes: [
          'id',
          'type',
          [fn('substr', col('data_url'), 1, 32), 'prefix'],
          [fn('substr', col('data_url'), -2), 'suffix'],
          [fn('length', cast(col('data_url'), 'BLOB')), 'length']
        ],
        where: { photoWallId, ...(type ? { type } : {}) },
        order: [['id', 'ASC']],
        transaction: options?.transaction,
        logging: false
      })
      return rows.map((row) => ({
        id: row.id,
        type: row.type,
        prefix: String(row.get('prefix')),
        suffix: String(row.get('suffix')),
        length: Number(row.get('length'))
      }))
    } catch (error) {
      return this.handleError(error)
    }
  }

  async deleteForWall(
    photoWallId: number,
    type: PhotoWallImageType,
    id?: number,
    options?: QueryOptions
  ): Promise<void> {
    try {
      await this.model.destroy({
        where: { photoWallId, type, ...(id === undefined ? {} : { id }) },
        transaction: options?.transaction,
        force: true,
        hooks: true,
        logging: false
      })
    } catch (error) {
      return this.handleError(error)
    }
  }

  async deleteAllForWall(photoWallId: number, options?: QueryOptions): Promise<void> {
    try {
      await this.model.destroy({
        where: { photoWallId },
        transaction: options?.transaction,
        force: true,
        hooks: true,
        logging: false
      })
    } catch (error) {
      return this.handleError(error)
    }
  }

  async deleteByIds(ids: number[], options?: QueryOptions): Promise<void> {
    if (!ids.length) return
    try {
      await this.model.destroy({
        where: { id: { [Op.in]: ids } },
        transaction: options?.transaction,
        force: true,
        hooks: true,
        logging: false
      })
    } catch (error) {
      return this.handleError(error)
    }
  }
}

export default PhotoWallImageRepository
