/**
 * Itinerary repository: all queries filter by the owning user, drawing the
 * ownership boundary at the data-access layer. Provides helpers for the
 * soft-deleted (abandoned) list, restore and permanent delete.
 */
import { Op, type Transaction } from 'sequelize'
import type { ItineraryCreationAttributes } from '../models/itinerary.model'
import { Itinerary } from '../models/itinerary.model'
import { AppError } from '../../errors'
import { BaseRepository } from './BaseRepository'
import { withReadSnapshot } from '../transaction'

type QueryOptions = { transaction?: Transaction; paranoid?: boolean }

/** Itinerary data access, always filtered by the owning user. */
export class ItineraryRepository extends BaseRepository<Itinerary, ItineraryCreationAttributes> {
  constructor() {
    super(Itinerary, ['uuid', 'userId', 'name'])
  }

  async readSnapshot<R>(operation: (transaction: Transaction) => Promise<R>): Promise<R> {
    try {
      return await withReadSnapshot(this.model.sequelize!, operation)
    } catch (error) {
      return this.handleError(error)
    }
  }

  /** Loads an itinerary only when it belongs to `userId` and is not soft-deleted. */
  async findOwnedById(
    userId: number,
    id: number,
    options?: QueryOptions
  ): Promise<Itinerary | null> {
    try {
      return await this.model.findOne({
        attributes: [
          'id',
          'uuid',
          'userId',
          'name',
          'createdAt',
          'updatedAt',
          'deletedAt',
          'version'
        ],
        where: { id, userId },
        transaction: options?.transaction,
        paranoid: options?.paranoid ?? true,
        logging: false
      })
    } catch (error) {
      return this.handleError(error)
    }
  }

  /** Lists all active itineraries for a user, most recently updated first. */
  async findAllOwned(userId: number, options?: QueryOptions): Promise<Itinerary[]> {
    try {
      return await this.model.findAll({
        attributes: [
          'id',
          'uuid',
          'userId',
          'name',
          'createdAt',
          'updatedAt',
          'deletedAt',
          'version'
        ],
        where: { userId },
        order: [
          ['updatedAt', 'DESC'],
          ['id', 'DESC']
        ],
        transaction: options?.transaction,
        paranoid: options?.paranoid ?? true,
        logging: false
      })
    } catch (error) {
      return this.handleError(error)
    }
  }

  /** Lists all abandoned (soft-deleted) itineraries for a user, most recently deleted first. */
  async findAllAbandoned(userId: number, options?: QueryOptions): Promise<Itinerary[]> {
    try {
      return await this.model.findAll({
        attributes: [
          'id',
          'uuid',
          'userId',
          'name',
          'createdAt',
          'updatedAt',
          'deletedAt',
          'version'
        ],
        where: { userId, deletedAt: { [Op.ne]: null } },
        order: [
          ['deletedAt', 'DESC'],
          ['id', 'DESC']
        ],
        transaction: options?.transaction,
        paranoid: false,
        logging: false
      })
    } catch (error) {
      return this.handleError(error)
    }
  }

  /** The final SQL keeps ownership, delete time and version so a restored parent row cannot be deleted. */
  async purgeAbandoned(instance: Itinerary, transaction: Transaction): Promise<boolean> {
    try {
      if (!instance.deletedAt) throw new AppError('Itinerary is not abandoned.', 'DATA_CONFLICT')
      const where = {
        id: instance.id,
        userId: instance.userId,
        deletedAt: instance.deletedAt,
        version: Number(instance.get('version'))
      }
      const count = await this.model.destroy({
        where,
        transaction,
        force: true,
        hooks: true,
        logging: false
      })
      if (count !== 1) throw new AppError('Itinerary changed.', 'DATA_CONFLICT')
      return true
    } catch (error) {
      return this.handleError(error)
    }
  }

  async restoreAbandoned(instance: Itinerary, transaction: Transaction): Promise<boolean> {
    try {
      if (!instance.deletedAt) throw new AppError('Itinerary is not abandoned.', 'DATA_CONFLICT')
      const where = {
        id: instance.id,
        userId: instance.userId,
        deletedAt: instance.deletedAt,
        version: Number(instance.get('version'))
      }
      const count = await this.model.restore({
        where,
        transaction,
        hooks: true,
        individualHooks: true,
        logging: false
      })
      // Sequelize 6 types this as void, but it actually returns the bulkUpdate affected-row count.
      if (Number(count) !== 1) throw new AppError('Itinerary changed.', 'DATA_CONFLICT')
      return true
    } catch (error) {
      return this.handleError(error)
    }
  }

  /** Restores a soft-deleted itinerary (moves it from abandoned back to active). */
  async restore(id: number, options?: QueryOptions): Promise<boolean> {
    try {
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new AppError('Invalid record ID.', 'INVALID_INPUT')
      }
      return await this.transaction(async (transaction) => {
        const instance = await this.model.findOne({
          where: { id, deletedAt: { [Op.ne]: null } },
          transaction,
          paranoid: false,
          logging: false
        })
        if (!instance) return false
        return this.restoreAbandoned(instance, transaction)
      }, options)
    } catch (error) {
      return this.handleError(error)
    }
  }
}

export default ItineraryRepository
