/**
 * Itinerary leg entity: connects two adjacent places and records the transport
 * mode and estimated travel time (in minutes).
 */
import { AllowNull, BelongsTo, Column, DataType, ForeignKey, Table } from 'sequelize-typescript'
import type { TransportMode } from '@common/itinerary'
import { BaseAttributes, BaseCreationAttributes, BaseModel } from './BaseModel'
import { Itinerary } from './itinerary.model'

/** Persisted leg attributes. */
export interface ItineraryLegAttributes extends BaseAttributes {
  itineraryId: number
  fromPlaceId: number
  toPlaceId: number
  mode: TransportMode
  durationMinutes: number
  sortOrder: number
}

/** Fields required when creating a leg. */
export interface ItineraryLegCreationAttributes extends BaseCreationAttributes {
  itineraryId: number
  fromPlaceId: number
  toPlaceId: number
  mode: TransportMode
  durationMinutes: number
  sortOrder: number
}

@Table({
  tableName: 'itinerary_legs',
  modelName: 'ItineraryLeg',
  indexes: [{ name: 'itinerary_legs_itinerary_id', fields: ['itinerary_id'] }]
})
/** A leg of travel between two adjacent places. */
export class ItineraryLeg extends BaseModel<
  ItineraryLegAttributes,
  ItineraryLegCreationAttributes
> {
  @ForeignKey(() => Itinerary)
  @AllowNull(false)
  @Column(DataType.INTEGER)
  declare itineraryId: number

  @AllowNull(false)
  @Column(DataType.INTEGER)
  declare fromPlaceId: number

  @AllowNull(false)
  @Column(DataType.INTEGER)
  declare toPlaceId: number

  @AllowNull(false)
  @Column(DataType.STRING(16))
  declare mode: TransportMode

  @AllowNull(false)
  @Column(DataType.INTEGER)
  declare durationMinutes: number

  @AllowNull(false)
  @Column(DataType.INTEGER)
  declare sortOrder: number

  @BelongsTo(() => Itinerary)
  declare itinerary?: Itinerary
}
