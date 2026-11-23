/**
 * Itinerary entity owned by a user. An itinerary consists of multiple places
 * and travel legs, and supports soft deletion: soft delete moves it into the
 * "abandoned itineraries" list, while restore and permanent delete are handled
 * by the service layer.
 */
import {
  AllowNull,
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  HasMany,
  Table,
  Unique
} from 'sequelize-typescript'
import { BaseAttributes, BaseCreationAttributes, BaseModel } from './BaseModel'
import { User } from './user.model'
import { ItineraryPlace } from './itinerary-place.model'
import { ItineraryLeg } from './itinerary-leg.model'

/** Persisted itinerary attributes. */
export interface ItineraryAttributes extends BaseAttributes {
  uuid: string
  userId: number
  name: string
}

/** Fields required when creating an itinerary. */
export interface ItineraryCreationAttributes extends BaseCreationAttributes {
  uuid: string
  userId: number
  name: string
}

@Table({
  tableName: 'itineraries',
  modelName: 'Itinerary',
  version: true,
  indexes: [{ name: 'itineraries_user_id', fields: ['user_id'] }]
})
/** User-owned itinerary; its soft-deleted state is the "abandoned itinerary". */
export class Itinerary extends BaseModel<ItineraryAttributes, ItineraryCreationAttributes> {
  // Public identifier exposed to clients; the integer `id` remains internal.
  @Unique
  @AllowNull(false)
  @Column(DataType.UUID)
  declare uuid: string

  @ForeignKey(() => User)
  @AllowNull(false)
  @Column(DataType.INTEGER)
  declare userId: number

  @AllowNull(false)
  @Column(DataType.STRING(120))
  declare name: string

  @BelongsTo(() => User)
  declare user?: User

  @HasMany(() => ItineraryPlace)
  declare places?: ItineraryPlace[]

  @HasMany(() => ItineraryLeg)
  declare legs?: ItineraryLeg[]
}
