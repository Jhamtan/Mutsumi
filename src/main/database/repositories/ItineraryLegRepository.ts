/**
 * Itinerary leg repository: reads and writes legs scoped to their itinerary,
 * with whole-batch hard delete.
 */
import { type Transaction } from 'sequelize'
import type { ItineraryLegCreationAttributes } from '../models/itinerary-leg.model'
import { ItineraryLeg } from '../models/itinerary-leg.model'
import { BaseRepository } from './BaseRepository'

type QueryOptions = { transaction?: Transaction }

/** Leg data access. */
export class ItineraryLegRepository extends BaseRepository<
  ItineraryLeg,
  ItineraryLegCreationAttributes
> {
  constructor() {
    super(ItineraryLeg, [
      'itineraryId',
      'fromPlaceId',
      'toPlaceId',
      'mode',
      'durationMinutes',
      'sortOrder'
    ])
  }

  /** Lists all legs of an itinerary in order. */
  async findAllForItinerary(itineraryId: number, options?: QueryOptions): Promise<ItineraryLeg[]> {
    try {
      return await this.model.findAll({
        attributes: [
          'id',
          'itineraryId',
          'fromPlaceId',
          'toPlaceId',
          'mode',
          'durationMinutes',
          'sortOrder'
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

  /** Hard-deletes all legs of an itinerary. */
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

export default ItineraryLegRepository
