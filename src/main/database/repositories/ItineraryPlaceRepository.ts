/**
 * Itinerary place repository: reads and writes places scoped to their
 * itinerary, with bulk fetch and whole-batch hard delete.
 */
import { Op, type Transaction } from 'sequelize'
import type { ItineraryPlaceCreationAttributes } from '../models/itinerary-place.model'
import { ItineraryPlace } from '../models/itinerary-place.model'
import { BaseRepository } from './BaseRepository'

type QueryOptions = { transaction?: Transaction }

/** Itinerary place data access. */
export class ItineraryPlaceRepository extends BaseRepository<
  ItineraryPlace,
  ItineraryPlaceCreationAttributes
> {
  constructor() {
    super(ItineraryPlace, [
      'itineraryId',
      'name',
      'role',
      'sortOrder',
      'arrivalTime',
      'departureTime',
      'stayMinutes'
    ])
  }

  /** Lists all places of an itinerary in order. */
  async findAllForItinerary(
    itineraryId: number,
    options?: QueryOptions
  ): Promise<ItineraryPlace[]> {
    try {
      return await this.model.findAll({
        attributes: [
          'id',
          'itineraryId',
          'name',
          'role',
          'sortOrder',
          'arrivalTime',
          'departureTime',
          'stayMinutes'
        ],
        where: { itineraryId },
        order: [['sortOrder', 'ASC']],
        transaction: options?.transaction,
        logging: false
      })
    } catch (error) {
      return this.handleError(error)
    }
  }

  /** Fetches places for multiple itineraries, grouped by itinerary and ordered. */
  async findAllForItineraries(
    itineraryIds: number[],
    options?: QueryOptions
  ): Promise<ItineraryPlace[]> {
    if (itineraryIds.length === 0) return []
    try {
      return await this.model.findAll({
        attributes: [
          'id',
          'itineraryId',
          'name',
          'role',
          'sortOrder',
          'arrivalTime',
          'departureTime',
          'stayMinutes'
        ],
        where: { itineraryId: { [Op.in]: itineraryIds } },
        order: [
          ['itineraryId', 'ASC'],
          ['sortOrder', 'ASC']
        ],
        transaction: options?.transaction,
        logging: false
      })
    } catch (error) {
      return this.handleError(error)
    }
  }

  /** Hard-deletes all places of an itinerary. */
  async deleteAllForItinerary(itineraryId: number, options?: QueryOptions): Promise<void> {
    try {
      await this.model.destroy({
        where: { itineraryId },
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

export default ItineraryPlaceRepository
