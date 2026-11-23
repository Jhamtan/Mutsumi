/**
 * Repository for notebooks. Every query scopes by the owning user so ownership
 * boundaries are enforced at the data-access layer.
 */
import type { Transaction } from 'sequelize'
import type { NotebookCreationAttributes } from '../models/notebook.model'
import { Notebook } from '../models/notebook.model'
import { BaseRepository } from './BaseRepository'

type QueryOptions = { transaction?: Transaction; paranoid?: boolean }

/** Data access for notebooks, always filtered by the owning user. */
export class NotebookRepository extends BaseRepository<Notebook, NotebookCreationAttributes> {
  constructor() {
    super(Notebook, [
      'uuid',
      'userId',
      'name',
      'cryptoVersion',
      'kdfAlgorithm',
      'kdfSalt',
      'kdfN',
      'kdfR',
      'kdfP',
      'wrappedKey',
      'wrappedKeyNonce',
      'wrappedKeyTag'
    ])
  }

  /** Loads a notebook by id only if it belongs to `userId`. */
  async findOwnedById(
    userId: number,
    id: number,
    options?: QueryOptions
  ): Promise<Notebook | null> {
    try {
      return await this.model.findOne({
        where: { id, userId },
        transaction: options?.transaction,
        paranoid: options?.paranoid ?? true,
        logging: false
      })
    } catch (error) {
      return this.handleError(error)
    }
  }

  /** Loads a notebook by uuid only if it belongs to `userId`. */
  async findOwnedByUuid(
    userId: number,
    uuid: string,
    options?: QueryOptions
  ): Promise<Notebook | null> {
    try {
      return await this.model.findOne({
        where: { uuid, userId },
        transaction: options?.transaction,
        paranoid: options?.paranoid ?? true,
        logging: false
      })
    } catch (error) {
      return this.handleError(error)
    }
  }

  /** Lists all notebooks owned by `userId`, newest first. */
  async findAllOwned(userId: number, options?: QueryOptions): Promise<Notebook[]> {
    try {
      return await this.model.findAll({
        where: { userId },
        order: [
          ['updatedAt', 'DESC'],
          ['id', 'DESC']
        ],
        transaction: options?.transaction,
        logging: false
      })
    } catch (error) {
      return this.handleError(error)
    }
  }

  /** Finds an owned notebook by name (used for duplicate-name checks). */
  async findName(userId: number, name: string, options?: QueryOptions): Promise<Notebook | null> {
    try {
      return await this.model.findOne({
        where: { userId, name },
        transaction: options?.transaction,
        logging: false
      })
    } catch (error) {
      return this.handleError(error)
    }
  }
}

export default NotebookRepository
