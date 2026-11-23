/**
 * Repository for diary images, scoped to their parent diary, with bulk fetch and
 * hard-delete helpers.
 */
import { literal, Op, type Transaction } from 'sequelize'
import type { DiaryImageCreationAttributes } from '../models/diary-image.model'
import { DiaryImage } from '../models/diary-image.model'
import { BaseRepository } from './BaseRepository'

type QueryOptions = { transaction?: Transaction; limit?: number }

export type DiaryImageMetadata = Pick<
  DiaryImage,
  'id' | 'uuid' | 'diaryId' | 'mimeType' | 'byteLength'
> & {
  ciphertextByteLength: number
}

/** Data access for diary images, always scoped to their parent diary. */
export class DiaryImageRepository extends BaseRepository<DiaryImage, DiaryImageCreationAttributes> {
  constructor() {
    super(DiaryImage, ['uuid', 'diaryId', 'mimeType', 'byteLength', 'ciphertext', 'nonce', 'tag'])
  }

  /** The bounded metadata pre-check reads no image ciphertext; the declared length must also match the real ciphertext length. */
  async findMetadataForDiary(
    diaryId: number,
    options?: QueryOptions
  ): Promise<DiaryImageMetadata[]> {
    try {
      const rows = await this.model.findAll({
        attributes: [
          'id',
          'uuid',
          'diaryId',
          'mimeType',
          'byteLength',
          [
            literal(
              '(length(CAST("ciphertext" AS BLOB)) / 4) * 3 - CASE WHEN substr("ciphertext", -2) = \'==\' THEN 2 WHEN substr("ciphertext", -1) = \'=\' THEN 1 ELSE 0 END'
            ),
            'ciphertextByteLength'
          ]
        ],
        where: { diaryId },
        order: [['id', 'ASC']],
        transaction: options?.transaction,
        limit: options?.limit,
        logging: false
      })
      return rows.map((row) => ({
        id: row.id,
        uuid: row.uuid,
        diaryId: row.diaryId,
        mimeType: row.mimeType,
        byteLength: row.byteLength,
        ciphertextByteLength: Number(row.get('ciphertextByteLength'))
      }))
    } catch (error) {
      return this.handleError(error)
    }
  }

  /** Lists all images attached to a diary, in insertion order. */
  async findAllForDiary(diaryId: number, options?: QueryOptions): Promise<DiaryImage[]> {
    try {
      return await this.model.findAll({
        where: { diaryId },
        order: [['id', 'ASC']],
        transaction: options?.transaction,
        logging: false
      })
    } catch (error) {
      return this.handleError(error)
    }
  }

  /** Lists all images for a set of diaries, grouped by diary then insertion order. */
  async findAllForDiaries(diaryIds: number[], options?: QueryOptions): Promise<DiaryImage[]> {
    if (diaryIds.length === 0) return []
    try {
      return await this.model.findAll({
        where: { diaryId: { [Op.in]: diaryIds } },
        order: [
          ['diaryId', 'ASC'],
          ['id', 'ASC']
        ],
        transaction: options?.transaction,
        logging: false
      })
    } catch (error) {
      return this.handleError(error)
    }
  }

  /** Delete a scoped image using metadata only, preserving instance hooks. */
  async deleteInDiary(diaryId: number, imageId: number, options?: QueryOptions): Promise<boolean> {
    return this.deleteScoped(
      imageId,
      true,
      { diaryId },
      ['uuid', 'diaryId', 'mimeType', 'byteLength', 'createdAt', 'updatedAt', 'deletedAt'],
      options
    )
  }

  /** Hard-deletes all images for a diary, running destroy hooks. */
  async deleteAllForDiary(diaryId: number, options?: QueryOptions): Promise<void> {
    try {
      await this.model.destroy({
        where: { diaryId },
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

export default DiaryImageRepository
