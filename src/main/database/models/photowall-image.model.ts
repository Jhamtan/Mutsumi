/**
 * Photo wall image entity: a regular photo or the portrait image. Images are
 * stored as data URLs and consumed directly by the renderer at display time;
 * dataUrl is business data and is not stripped from serialization.
 */
import { AllowNull, BelongsTo, Column, DataType, ForeignKey, Table } from 'sequelize-typescript'
import type { PhotoWallImageType } from '@common/photowall'
import { BaseAttributes, BaseCreationAttributes, BaseModel } from './BaseModel'
import { PhotoWall } from './photowall.model'

/** Persisted photo wall image attributes. */
export interface PhotoWallImageAttributes extends BaseAttributes {
  photoWallId: number
  type: PhotoWallImageType
  dataUrl: string
}

/** Fields required when creating a photo wall image. */
export interface PhotoWallImageCreationAttributes extends BaseCreationAttributes {
  photoWallId: number
  type: PhotoWallImageType
  dataUrl: string
}

@Table({
  tableName: 'photo_wall_images',
  modelName: 'PhotoWallImage',
  indexes: [{ name: 'photo_wall_images_wall_id', fields: ['photo_wall_id'] }]
})
/** An image on the photo wall. */
export class PhotoWallImage extends BaseModel<
  PhotoWallImageAttributes,
  PhotoWallImageCreationAttributes
> {
  @ForeignKey(() => PhotoWall)
  @AllowNull(false)
  @Column(DataType.INTEGER)
  declare photoWallId: number

  @AllowNull(false)
  @Column(DataType.STRING(16))
  declare type: PhotoWallImageType

  @AllowNull(false)
  @Column(DataType.TEXT)
  declare dataUrl: string

  @BelongsTo(() => PhotoWall)
  declare photoWall?: PhotoWall
}
