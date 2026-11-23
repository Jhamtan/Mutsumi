/**
 * Diary entity scoped to a notebook. Content is stored as AEAD-encrypted fields
 * (`contentCiphertext`/`contentNonce`/`contentTag`) and stripped from serialization.
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
import { Notebook } from './notebook.model'
import { DiaryImage } from './diary-image.model'

/** Persisted diary attributes, including encrypted content fields. */
export interface DiaryAttributes extends BaseAttributes {
  uuid: string
  notebookId: number
  occurredAt: Date
  contentCiphertext: string
  contentNonce: string
  contentTag: string
}

/** Fields required when creating a diary. */
export interface DiaryCreationAttributes extends BaseCreationAttributes {
  uuid: string
  notebookId: number
  occurredAt: Date
  contentCiphertext: string
  contentNonce: string
  contentTag: string
}

@Table({
  tableName: 'diaries',
  modelName: 'Diary',
  version: true,
  indexes: [
    { name: 'diaries_notebook_id', fields: ['notebook_id'] },
    { name: 'diaries_occurred_at', fields: ['occurred_at'] }
  ]
})
/** Diary entry whose content is stored encrypted and excluded from toJSON(). */
export class Diary extends BaseModel<DiaryAttributes, DiaryCreationAttributes> {
  // Public identifier exposed to clients; the integer `id` remains internal.
  @Unique
  @AllowNull(false)
  @Column(DataType.UUID)
  declare uuid: string

  @ForeignKey(() => Notebook)
  @AllowNull(false)
  @Column(DataType.INTEGER)
  declare notebookId: number

  @AllowNull(false)
  @Column(DataType.DATE)
  declare occurredAt: Date

  // AEAD-encrypted diary content: ciphertext plus its nonce and auth tag.
  @AllowNull(false)
  @Column(DataType.TEXT)
  declare contentCiphertext: string

  @AllowNull(false)
  @Column(DataType.STRING(64))
  declare contentNonce: string

  @AllowNull(false)
  @Column(DataType.STRING(64))
  declare contentTag: string

  @BelongsTo(() => Notebook)
  declare notebook?: Notebook

  @HasMany(() => DiaryImage)
  declare images?: DiaryImage[]

  /** Strips encrypted content fields so plaintext never leaves the main process. */
  toJSON(): object {
    const values = Object.assign({}, this.get()) as unknown as Record<string, unknown>
    delete values.contentCiphertext
    delete values.contentNonce
    delete values.contentTag
    return values
  }
}
