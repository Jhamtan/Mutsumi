/**
 * Repository for diaries, scoped to their parent notebook. Provides a consistent
 * read-snapshot helper for multi-record reads.
 */
import { literal, Op, type Transaction } from 'sequelize'
import type { DiaryCreationAttributes } from '../models/diary.model'
import { Diary } from '../models/diary.model'
import { withReadSnapshot } from '../transaction'
import { BaseRepository } from './BaseRepository'

type QueryOptions = { transaction?: Transaction; limit?: number; offset?: number }

export type DiaryMetadata = Pick<
  Diary,
  'id' | 'uuid' | 'notebookId' | 'occurredAt' | 'createdAt' | 'updatedAt'
> & { contentByteLength: number }

/** Data access for diaries, always scoped to their parent notebook. */
export class DiaryRepository extends BaseRepository<Diary, DiaryCreationAttributes> {
  constructor() {
    super(Diary, [
      'uuid',
      'notebookId',
      'occurredAt',
      'contentCiphertext',
      'contentNonce',
      'contentTag'
    ])
  }

  /** Runs `operation` inside a consistent read snapshot for multi-record reads. */
  async readSnapshot<R>(operation: (transaction: Transaction) => Promise<R>): Promise<R> {
    try {
      return await withReadSnapshot(this.model.sequelize!, operation)
    } catch (error) {
      return this.handleError(error)
    }
  }

  /** Counts within the parent notebook only, excluding soft-deleted records by default and without loading the body. */
  async countInNotebook(notebookId: number, options?: QueryOptions): Promise<number> {
    try {
      return await this.model.count({
        where: { notebookId },
        transaction: options?.transaction,
        logging: false
      })
    } catch (error) {
      return this.handleError(error)
    }
  }

  /** Fetches only metadata and the SQL-computed decoded length, so oversized legacy ciphertext never enters memory. */
  async findMetadataInNotebook(
    notebookId: number,
    ids: number[] = [],
    options?: QueryOptions
  ): Promise<DiaryMetadata[]> {
    try {
      const rows = await this.model.findAll({
        attributes: [
          'id',
          'uuid',
          'notebookId',
          'occurredAt',
          'createdAt',
          'updatedAt',
          [
            literal(
              '(length(CAST("content_ciphertext" AS BLOB)) / 4) * 3 - CASE WHEN substr("content_ciphertext", -2) = \'==\' THEN 2 WHEN substr("content_ciphertext", -1) = \'=\' THEN 1 ELSE 0 END'
            ),
            'contentByteLength'
          ]
        ],
        where: { notebookId, ...(ids.length ? { id: { [Op.in]: ids } } : {}) },
        order: [
          ['occurredAt', 'DESC'],
          ['id', 'DESC']
        ],
        transaction: options?.transaction,
        limit: options?.limit,
        offset: options?.offset,
        logging: false
      })
      return rows.map((row) => ({
        id: row.id,
        uuid: row.uuid,
        notebookId: row.notebookId,
        occurredAt: row.occurredAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        contentByteLength: Number(row.get('contentByteLength'))
      }))
    } catch (error) {
      return this.handleError(error)
    }
  }

  /** Delete using only scoped identity/version metadata, never the encrypted body. */
  async deleteInNotebook(
    notebookId: number,
    diaryId: number,
    options?: QueryOptions
  ): Promise<boolean> {
    return this.deleteScoped(
      diaryId,
      false,
      { notebookId },
      ['uuid', 'notebookId', 'occurredAt', 'createdAt', 'updatedAt', 'deletedAt'],
      options
    )
  }

  /** Loads a diary by id only if it belongs to `notebookId`. */
  async findInNotebook(
    notebookId: number,
    diaryId: number,
    options?: QueryOptions
  ): Promise<Diary | null> {
    try {
      return await this.model.findOne({
        where: { id: diaryId, notebookId },
        transaction: options?.transaction,
        logging: false
      })
    } catch (error) {
      return this.handleError(error)
    }
  }

  /** Loads a diary by uuid only if it belongs to `notebookId`. */
  async findByUuidInNotebook(
    notebookId: number,
    uuid: string,
    options?: QueryOptions
  ): Promise<Diary | null> {
    try {
      return await this.model.findOne({
        where: { uuid, notebookId },
        transaction: options?.transaction,
        logging: false
      })
    } catch (error) {
      return this.handleError(error)
    }
  }

  /** Lists all diaries in a notebook, newest occurrence first. */
  async findAllInNotebook(notebookId: number, options?: QueryOptions): Promise<Diary[]> {
    try {
      return await this.model.findAll({
        where: { notebookId },
        order: [
          ['occurredAt', 'DESC'],
          ['id', 'DESC']
        ],
        transaction: options?.transaction,
        logging: false
      })
    } catch (error) {
      return this.handleError(error)
    }
  }

  /** Lists the diaries with the given ids in a notebook (all when ids is empty). */
  async findSelectedInNotebook(
    notebookId: number,
    ids: number[],
    options?: QueryOptions
  ): Promise<Diary[]> {
    if (ids.length === 0) return this.findAllInNotebook(notebookId, options)
    try {
      return await this.model.findAll({
        where: { notebookId, id: { [Op.in]: ids } },
        order: [
          ['occurredAt', 'DESC'],
          ['id', 'DESC']
        ],
        transaction: options?.transaction,
        logging: false
      })
    } catch (error) {
      return this.handleError(error)
    }
  }
}

export default DiaryRepository
