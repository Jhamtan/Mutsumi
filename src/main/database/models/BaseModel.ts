/**
 * Shared base model: auto-increment integer primary key plus underscored
 * timestamps and paranoid (soft-delete) support.
 */
import {
  Model,
  Column,
  DataType,
  CreatedAt,
  UpdatedAt,
  DeletedAt,
  Table
} from 'sequelize-typescript'
import { Optional } from 'sequelize'

/** Common persisted attributes present on every model. */
export interface BaseAttributes {
  id: number
  createdAt?: Date
  updatedAt?: Date
  deletedAt?: Date | null
}
// Creation-time constraint: all system fields should be optional
/** Creation attributes: system fields are optional and filled by the database. */
export interface BaseCreationAttributes extends Optional<
  BaseAttributes,
  'id' | 'createdAt' | 'deletedAt' | 'updatedAt'
> {}

@Table({
  timestamps: true, // enable createdAt and updatedAt
  paranoid: true, // enable soft delete (deletedAt)
  underscored: true // use snake_case column names (created_at)
})
/**
 * Abstract base entity providing `id`, `createdAt`, `updatedAt` and soft-delete
 * `deletedAt`; columns are snake_cased and managed automatically by Sequelize.
 */
export abstract class BaseModel<
  T extends BaseAttributes = BaseAttributes,
  TCreation extends BaseCreationAttributes = BaseCreationAttributes
> extends Model<T, TCreation> {
  @Column({
    primaryKey: true,
    autoIncrement: true,
    type: DataType.INTEGER,
    comment: 'Auto-increment id'
  })
  declare id: number

  @CreatedAt
  @Column({
    type: DataType.DATE,
    comment: 'Creation time'
  })
  declare createdAt: Date

  @UpdatedAt
  @Column({
    type: DataType.DATE,
    comment: 'Update time'
  })
  declare updatedAt: Date

  @DeletedAt
  @Column({
    type: DataType.DATE,
    comment: 'Soft-delete time'
  })
  declare deletedAt?: Date | null
}
