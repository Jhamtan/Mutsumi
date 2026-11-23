/**
 * Diary image entity scoped to a diary. Binary content is stored as
 * AEAD-encrypted fields (`ciphertext`/`nonce`/`tag`) and stripped from serialization.
 */
import {
  AllowNull,
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Table,
  Unique
} from 'sequelize-typescript'
import { BaseAttributes, BaseCreationAttributes, BaseModel } from './BaseModel'
import { Diary } from './diary.model'

/** Persisted image attributes, including encrypted content fields. */
export interface DiaryImageAttributes extends BaseAttributes {
  uuid: string
  diaryId: number
  mimeType: string
  byteLength: number
  ciphertext: string
  nonce: string
  tag: string
}

/** Fields required when creating a diary image. */
export interface DiaryImageCreationAttributes extends BaseCreationAttributes {
  uuid: string
  diaryId: number
  mimeType: string
  byteLength: number
  ciphertext: string
  nonce: string
  tag: string
}

@Table({
  tableName: 'diary_images',
  modelName: 'DiaryImage',
  indexes: [{ name: 'diary_images_diary_id', fields: ['diary_id'] }]
})
/** Image attachment whose encrypted bytes are excluded from toJSON(). */
export class DiaryImage extends BaseModel<DiaryImageAttributes, DiaryImageCreationAttributes> {
  // Public identifier exposed to clients; the integer `id` remains internal.
  @Unique
  @AllowNull(false)
  @Column(DataType.UUID)
  declare uuid: string

  @ForeignKey(() => Diary)
  @AllowNull(false)
  @Column(DataType.INTEGER)
  declare diaryId: number

  @AllowNull(false)
  @Column(DataType.STRING(32))
  declare mimeType: string

  @AllowNull(false)
  @Column(DataType.INTEGER)
  declare byteLength: number

  // AEAD-encrypted image bytes: ciphertext plus its nonce and auth tag.
  @AllowNull(false)
  @Column(DataType.TEXT)
  declare ciphertext: string

  @AllowNull(false)
  @Column(DataType.STRING(64))
  declare nonce: string

  @AllowNull(false)
  @Column(DataType.STRING(64))
  declare tag: string

  @BelongsTo(() => Diary)
  declare diary?: Diary

  /** Strips encrypted fields so raw bytes never leave the main process. */
  toJSON(): object {
    const values = Object.assign({}, this.get()) as unknown as Record<string, unknown>
    delete values.ciphertext
    delete values.nonce
    delete values.tag
    return values
  }
}
