/**
 * Notebook entity owned by a user. Carries per-notebook key-encryption metadata
 * (KDF parameters and a wrapped content key) that is excluded from serialization.
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
import { Diary } from './diary.model'

/** Persisted notebook attributes, including key-encryption metadata. */
export interface NotebookAttributes extends BaseAttributes {
  uuid: string
  userId: number
  name: string
  cryptoVersion: number
  kdfAlgorithm: string
  kdfSalt: string
  kdfN: number
  kdfR: number
  kdfP: number
  wrappedKey: string
  wrappedKeyNonce: string
  wrappedKeyTag: string
}

/** Fields required when creating a notebook. */
export interface NotebookCreationAttributes extends BaseCreationAttributes {
  uuid: string
  userId: number
  name: string
  cryptoVersion: number
  kdfAlgorithm: string
  kdfSalt: string
  kdfN: number
  kdfR: number
  kdfP: number
  wrappedKey: string
  wrappedKeyNonce: string
  wrappedKeyTag: string
}

@Table({
  tableName: 'notebooks',
  modelName: 'Notebook',
  version: true,
  indexes: [{ name: 'notebooks_user_id', fields: ['user_id'] }]
})
/** User-owned notebook; content keys are wrapped per notebook and never serialized. */
export class Notebook extends BaseModel<NotebookAttributes, NotebookCreationAttributes> {
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
  @Column(DataType.STRING(80))
  declare name: string

  // Key-encryption metadata: KDF parameters plus the AEAD-wrapped content key.
  @AllowNull(false)
  @Column(DataType.INTEGER)
  declare cryptoVersion: number

  @AllowNull(false)
  @Column(DataType.STRING(16))
  declare kdfAlgorithm: string

  @AllowNull(false)
  @Column(DataType.STRING(64))
  declare kdfSalt: string

  @AllowNull(false)
  @Column(DataType.INTEGER)
  declare kdfN: number

  @AllowNull(false)
  @Column(DataType.INTEGER)
  declare kdfR: number

  @AllowNull(false)
  @Column(DataType.INTEGER)
  declare kdfP: number

  @AllowNull(false)
  @Column(DataType.TEXT)
  declare wrappedKey: string

  @AllowNull(false)
  @Column(DataType.STRING(64))
  declare wrappedKeyNonce: string

  @AllowNull(false)
  @Column(DataType.STRING(64))
  declare wrappedKeyTag: string

  @BelongsTo(() => User)
  declare user?: User

  @HasMany(() => Diary)
  declare diaries?: Diary[]

  /** Strips key-encryption metadata so key material never leaves the main process. */
  toJSON(): object {
    const values = Object.assign({}, this.get()) as unknown as Record<string, unknown>
    for (const field of [
      'cryptoVersion',
      'kdfAlgorithm',
      'kdfSalt',
      'kdfN',
      'kdfR',
      'kdfP',
      'wrappedKey',
      'wrappedKeyNonce',
      'wrappedKeyTag'
    ]) {
      delete values[field]
    }
    return values
  }
}
