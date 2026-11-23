/**
 * Photo wall config entity, one per user. Stores settings such as the minimum
 * number of photos to upload.
 */
import {
  AllowNull,
  BelongsTo,
  Column,
  DataType,
  Default,
  ForeignKey,
  HasMany,
  Table,
  Unique
} from 'sequelize-typescript'
import {
  PHOTOWALL_MIN_IMAGES_DEFAULT,
  PHOTOWALL_ROUNDED_DEFAULT
} from '@common/photowall'
import { BaseAttributes, BaseCreationAttributes, BaseModel } from './BaseModel'
import { User } from './user.model'
import { PhotoWallImage } from './photowall-image.model'

/** Persisted photo wall config attributes. */
export interface PhotoWallAttributes extends BaseAttributes {
  userId: number
  minImages: number
  rounded: boolean
}

/** Fields required when creating a photo wall config. */
export interface PhotoWallCreationAttributes extends BaseCreationAttributes {
  userId: number
  minImages?: number
  rounded?: boolean
}

@Table({
  tableName: 'photo_walls',
  modelName: 'PhotoWall',
  version: true,
  indexes: [{ name: 'photo_walls_user_id', fields: ['user_id'], unique: true }]
})
/** One photo wall config per user. */
export class PhotoWall extends BaseModel<PhotoWallAttributes, PhotoWallCreationAttributes> {
  @Unique
  @ForeignKey(() => User)
  @AllowNull(false)
  @Column(DataType.INTEGER)
  declare userId: number

  @AllowNull(false)
  @Default(PHOTOWALL_MIN_IMAGES_DEFAULT)
  @Column(DataType.INTEGER)
  declare minImages: number

  @AllowNull(false)
  @Default(PHOTOWALL_ROUNDED_DEFAULT)
  @Column(DataType.BOOLEAN)
  declare rounded: boolean

  @BelongsTo(() => User)
  declare user?: User

  @HasMany(() => PhotoWallImage)
  declare images?: PhotoWallImage[]
}
