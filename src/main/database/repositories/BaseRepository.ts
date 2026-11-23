/**
 * Generic Sequelize repository: validated CRUD with CLS-aware transactions,
 * optimistic locking and soft-delete handling. Subclasses declare the model and
 * its writable business fields.
 */
import {
  Model,
  ModelStatic,
  Op,
  UniqueConstraintError,
  ValidationError,
  OptimisticLockError,
  FindOptions,
  Attributes,
  CreationAttributes,
  Transaction,
  WhereOptions,
  SaveOptions,
  InstanceDestroyOptions
} from 'sequelize'
import { AppError } from '../../errors'
import logger from '../../logger'
import { databaseErrorDetails } from '../errors'
import { withTransaction } from '../transaction'

type RepositoryOptions = { transaction?: Transaction }
type RepositoryFindOptions<T extends Model> = Omit<FindOptions<Attributes<T>>, 'raw' | 'plain'> & {
  raw?: false
  plain?: false
  hooks?: true
}

// TInput is the business input; writable fields must be declared explicitly, not derived from compile-time DTO types alone
/**
 * Base repository for a Sequelize model. Enforces a writable-field allow-list and
 * routes mutations through transactions, instance hooks and version checks.
 */
export abstract class BaseRepository<T extends Model, TInput = CreationAttributes<T>> {
  private readonly writableFields: ReadonlySet<string>

  constructor(
    protected readonly model: ModelStatic<T>,
    writableFields: readonly (keyof TInput & keyof Attributes<T> & string)[]
  ) {
    const { timestamps, createdAt, updatedAt, deletedAt, paranoid, version } = model.options
    const systemFields = new Set([
      ...model.primaryKeyAttributes,
      ...(timestamps
        ? [
            createdAt === false ? '' : typeof createdAt === 'string' ? createdAt : 'createdAt',
            updatedAt === false ? '' : typeof updatedAt === 'string' ? updatedAt : 'updatedAt',
            paranoid ? (typeof deletedAt === 'string' ? deletedAt : 'deletedAt') : ''
          ]
        : []),
      ...(version ? [typeof version === 'string' ? version : 'version'] : []),
      '__proto__',
      'constructor',
      'prototype'
    ])
    if (
      model.primaryKeyAttributes.length !== 1 ||
      writableFields.some(
        (field) =>
          !Object.prototype.hasOwnProperty.call(model.getAttributes(), field) ||
          systemFields.has(field)
      )
    ) {
      throw new Error('Repository requires one primary key and writable business attributes only.')
    }
    this.writableFields = new Set(writableFields)
  }

  // Multi-step business logic can share a transaction; only the layer that created the transaction commits or rolls back
  /** Runs `operation` in a transaction, sharing an existing transaction when provided. */
  async transaction<R>(
    operation: (transaction: Transaction) => Promise<R>,
    options?: RepositoryOptions
  ): Promise<R> {
    try {
      return await withTransaction(this.model.sequelize!, operation, options?.transaction)
    } catch (error) {
      return this.handleError(error)
    }
  }

  // Returns model instances; serialize via toJSON() or an explicit DTO before IPC
  /** Creates a record, validating input and running model hooks. */
  async create(data: TInput, options?: RepositoryOptions): Promise<T> {
    try {
      const values = this.validateInput(data)
      return await withTransaction(
        this.model.sequelize!,
        (transaction) =>
          this.model.create(values as CreationAttributes<T>, {
            transaction,
            hooks: true,
            validate: true,
            logging: false
          }),
        options?.transaction
      )
    } catch (error) {
      return this.handleError(error)
    }
  }

  // Keep instances, getters and afterFind hooks; forbid raw queries that bypass safe serialization
  /** Returns model instances; serialize via toJSON()/DTO before IPC. */
  async findAll(options?: RepositoryFindOptions<T>): Promise<T[]> {
    try {
      const queryOptions: RepositoryFindOptions<T> = {
        ...options,
        plain: false,
        raw: false,
        hooks: true,
        logging: false
      }
      return await this.model.findAll(queryOptions)
    } catch (error) {
      return this.handleError(error)
    }
  }

  /** Loads a single record by primary key. */
  async findById(id: number, options?: RepositoryOptions): Promise<T | null> {
    try {
      this.validateId(id)
      const queryOptions: RepositoryFindOptions<T> = {
        transaction: options?.transaction,
        raw: false,
        hooks: true,
        logging: false
      }
      return await this.model.findByPk(id, queryOptions)
    } catch (error) {
      return this.handleError(error)
    }
  }

  // Instance updates run validation and beforeUpdate/beforeSave; encryption metadata added by hooks is also saved
  /** Updates changed fields through instance validation, hooks and optimistic-lock checks. */
  async update(id: number, data: Partial<TInput>, options?: RepositoryOptions): Promise<boolean> {
    try {
      this.validateId(id)
      const values = this.validateInput(data)
      if (Object.keys(values).length === 0) return false

      return await withTransaction(
        this.model.sequelize!,
        async (transaction) => {
          const instance = await this.lookup(id, { transaction })
          if (!instance) return false

          // Scope the write by primary key plus the optimistic-lock version, then validate and run hooks on the live instance.
          const where = this.recordWhere(instance)
          instance.set(values as Partial<Attributes<T>>)
          const hookOptions: SaveOptions<Attributes<T>> = {
            transaction,
            hooks: true,
            validate: true,
            logging: false
          }
          await this.validateChanges(instance, hookOptions)
          // Sequelize 6 proxies beforeSave/afterSave to the Update hooks, so do not run them twice
          await this.runHook('beforeUpdate', instance, hookOptions)
          await this.validateChanges(instance, hookOptions)

          // Collect only the fields that actually changed and advance the optimistic-lock version for the WHERE clause.
          const changes = this.changedValues(instance)
          this.addVersion(instance, changes)
          if (Object.keys(changes).length === 0) return true
          // Hooks already ran on the real instance; the final SQL keeps paranoid/version conditions and checks the affected-row count
          const [count] = await this.model.update(changes as Partial<Attributes<T>>, {
            where,
            transaction,
            hooks: false,
            validate: false,
            sideEffects: false,
            logging: false
          })
          this.assertAffected(count)
          await this.runHook('afterUpdate', instance, hookOptions)
          return true
        },
        options?.transaction
      )
    } catch (error) {
      return this.handleError(error)
    }
  }

  // Instance deletion keeps beforeDestroy/afterDestroy; force hard-deletes records that were already soft-deleted
  /** Soft-deletes (or hard-deletes when `force`) a record, running destroy hooks. */
  async delete(id: number, force: boolean = false, options?: RepositoryOptions): Promise<boolean> {
    return this.deleteRecord(id, force, options)
  }

  /** Scoped cleanup can preserve instance hooks/version checks without loading large TEXT. */
  protected async deleteScoped(
    id: number,
    force: boolean,
    scope: WhereOptions<Attributes<T>>,
    attributes: string[],
    options?: RepositoryOptions
  ): Promise<boolean> {
    return this.deleteRecord(id, force, options, { scope, attributes })
  }

  private async deleteRecord(
    id: number,
    force: boolean,
    options?: RepositoryOptions,
    projection?: { scope: WhereOptions<Attributes<T>>; attributes: string[] }
  ): Promise<boolean> {
    try {
      this.validateId(id)
      if (typeof force !== 'boolean') {
        throw new AppError('Invalid delete mode.', 'INVALID_INPUT')
      }
      return await withTransaction(
        this.model.sequelize!,
        async (transaction) => {
          const queryOptions: RepositoryFindOptions<T> = {
            transaction,
            paranoid: !force,
            raw: false,
            hooks: true,
            logging: false
          }
          // A scoped projection loads only identity/version fields, avoiding large TEXT columns.
          if (projection) {
            const version = this.model.options.version
            queryOptions.attributes = [
              ...new Set([
                this.model.primaryKeyAttribute,
                ...(version ? [typeof version === 'string' ? version : 'version'] : []),
                ...projection.attributes
              ])
            ]
            queryOptions.where = {
              [Op.and]: [
                { [this.model.primaryKeyAttribute]: id } as WhereOptions<Attributes<T>>,
                projection.scope
              ]
            }
          }
          const instance = projection
            ? await this.model.findOne(queryOptions)
            : await this.model.findByPk(id, queryOptions)
          if (!instance) return false

          const identity = this.recordWhere(instance)
          const where = projection ? { [Op.and]: [identity, projection.scope] } : identity
          const hookOptions: InstanceDestroyOptions = {
            transaction,
            force,
            hooks: true,
            logging: false
          }
          // Run destroy hooks, then execute a scoped DELETE that ignores any hook-only field edits.
          await this.runHook('beforeDestroy', instance, hookOptions)
          // Delete only writes deletedAt or executes DELETE, never saving business fields changed by beforeDestroy
          const count = await this.model.destroy({
            where,
            transaction,
            force,
            hooks: false,
            logging: false
          })
          this.assertAffected(count)
          await this.runHook('afterDestroy', instance, hookOptions)
          return true
        },
        options?.transaction
      )
    } catch (error) {
      return this.handleError(error)
    }
  }

  private lookup(id: number, options?: RepositoryOptions): Promise<T | null> {
    return this.model.findByPk(id, { transaction: options?.transaction, logging: false })
  }

  // Scopes updates/deletes by primary key plus the optimistic-lock version column.
  private recordWhere(instance: T): WhereOptions<Attributes<T>> {
    const where: Record<string, unknown> = {
      [this.model.primaryKeyAttribute]: instance.get(this.model.primaryKeyAttribute)
    }
    const version = this.model.options.version
    if (version) {
      const field = typeof version === 'string' ? version : 'version'
      where[field] = instance.get(field)
    }
    return where as WhereOptions<Attributes<T>>
  }

  private changedValues(instance: T): Record<string, unknown> {
    const values: Record<string, unknown> = {}
    for (const field of instance.changed() || []) {
      if (Object.prototype.hasOwnProperty.call(this.model.getAttributes(), field)) {
        values[field] = instance.getDataValue(field)
      }
    }
    return values
  }

  private addVersion(instance: T, values: Record<string, unknown>): void {
    const version = this.model.options.version
    if (version && Object.keys(values).length) {
      const field = typeof version === 'string' ? version : 'version'
      values[field] = Number(instance.get(field)) + 1
    }
  }

  private async validateChanges(instance: T, options: SaveOptions<Attributes<T>>): Promise<void> {
    const fields = instance.changed() || []
    const validationOptions = {
      transaction: options.transaction,
      logging: false,
      hooks: true,
      skip: Object.keys(this.model.getAttributes()).filter((field) => !fields.includes(field))
    }
    await instance.validate(validationOptions)
  }

  private runHook(
    name: 'beforeUpdate' | 'afterUpdate' | 'beforeDestroy' | 'afterDestroy',
    instance: T,
    options: SaveOptions<Attributes<T>> | InstanceDestroyOptions
  ): Promise<void> {
    // Sequelize 6 provides runHooks, but its type declarations do not expose the method
    return (
      this.model as ModelStatic<T> & {
        runHooks(name: string, instance: T, options: unknown): Promise<void>
      }
    ).runHooks(name, instance, options)
  }

  private assertAffected(count: number): void {
    if (count !== 1) {
      throw new AppError(
        'The record changed or was deleted. Please reload and retry.',
        'DATA_CONFLICT'
      )
    }
  }

  private validateId(id: number): void {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new AppError('Invalid record ID.', 'INVALID_INPUT')
    }
  }

  private validateInput(data: unknown): Record<string, unknown> {
    if (
      !data ||
      typeof data !== 'object' ||
      (Object.getPrototypeOf(data) !== Object.prototype && Object.getPrototypeOf(data) !== null)
    ) {
      throw new AppError('Invalid repository input.', 'INVALID_INPUT')
    }
    const values: Record<string, unknown> = {}
    for (const field of Reflect.ownKeys(data)) {
      if (typeof field !== 'string' || !this.writableFields.has(field)) {
        throw new AppError('Input contains a non-writable field.', 'INVALID_INPUT')
      }
      const value = (data as Record<string, unknown>)[field]
      // Match Sequelize semantics: undefined means "not provided", so do not use it to clear an existing value
      if (value !== undefined) values[field] = value
    }
    return values
  }

  /** Maps low-level Sequelize errors to AppError without leaking SQL or data. */
  protected handleError(error: unknown): never {
    if (error instanceof UniqueConstraintError) {
      const fieldName = Object.keys(error.fields ?? {}).find((field) =>
        Object.prototype.hasOwnProperty.call(this.model.getAttributes(), field)
      )
      throw new AppError(
        fieldName ? `The ${fieldName} is already in use.` : 'The data is already in use.',
        'DATA_EXISTS'
      )
    }
    if (error instanceof AppError) throw error
    if (error instanceof ValidationError) {
      throw new AppError('Invalid data for database operation.', 'VALIDATION_ERROR')
    }
    if (error instanceof OptimisticLockError) {
      throw new AppError('The record was modified. Please reload and retry.', 'DATA_CONFLICT')
    }
    // Database errors may contain SQL, params, passwords or diary content; never log the whole error or propagate the cause
    logger.error('Database operation failed.', {
      model: this.model.name,
      ...databaseErrorDetails(error)
    })
    throw new Error('Database operation failed')
  }
}
