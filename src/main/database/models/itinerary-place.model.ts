/**
 * Itinerary place entity, scoped to an itinerary. Places are classified by role
 * into start / intermediate / end: a start point has only a departure time, an
 * end point has only an arrival time, and intermediate places have both arrival
 * and departure times plus a stay duration.
 */
import {
  AllowNull,
  BelongsTo,
  Column,
  DataType,
  Default,
  ForeignKey,
  Table
} from 'sequelize-typescript'
import type { TransportRole } from '@common/itinerary'
import { BaseAttributes, BaseCreationAttributes, BaseModel } from './BaseModel'
import { Itinerary } from './itinerary.model'

/** Persisted place attributes. */
export interface ItineraryPlaceAttributes extends BaseAttributes {
  itineraryId: number
  name: string
  role: TransportRole
  sortOrder: number
  arrivalTime: Date | null
  departureTime: Date | null
  stayMinutes: number
}

/** Fields required when creating a place. */
export interface ItineraryPlaceCreationAttributes extends BaseCreationAttributes {
  itineraryId: number
  name: string
  role: TransportRole
  sortOrder: number
  arrivalTime?: Date | null
  departureTime?: Date | null
  stayMinutes?: number
}

@Table({
  tableName: 'itinerary_places',
  modelName: 'ItineraryPlace',
  indexes: [{ name: 'itinerary_places_itinerary_id', fields: ['itinerary_id'] }]
})
/** A place within an itinerary. */
export class ItineraryPlace extends BaseModel<
  ItineraryPlaceAttributes,
  ItineraryPlaceCreationAttributes
> {
  @ForeignKey(() => Itinerary)
  @AllowNull(false)
  @Column(DataType.INTEGER)
  declare itineraryId: number

  @AllowNull(false)
  @Column(DataType.STRING(120))
  declare name: string

  @AllowNull(false)
  @Column(DataType.STRING(16))
  declare role: TransportRole

  @AllowNull(false)
  @Column(DataType.INTEGER)
  declare sortOrder: number

  // null for the start point; null for the end point (the end only records arrival time)
  @AllowNull(true)
  @Column(DataType.DATE)
  declare arrivalTime: Date | null

  // null for the end point (the end has no departure time)
  @AllowNull(true)
  @Column(DataType.DATE)
  declare departureTime: Date | null

  @AllowNull(false)
  @Default(0)
  @Column(DataType.INTEGER)
  declare stayMinutes: number

  @BelongsTo(() => Itinerary)
  declare itinerary?: Itinerary
}
