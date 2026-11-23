/**
 * User entity with bcrypt password hashing. Passwords are hashed on create/update
 * and stripped from serialized output so they never reach the renderer.
 */
import {
  Table,
  Column,
  Unique,
  AllowNull,
  IsEmail,
  BeforeCreate,
  BeforeUpdate,
  DataType,
  Length,
  Validate,
  HasMany
} from 'sequelize-typescript'
import { BaseModel, BaseAttributes, BaseCreationAttributes } from './BaseModel'
import * as bcrypt from 'bcryptjs'
import { isValidPlaintextPassword } from '../../../common/password'
import { Notebook } from './notebook.model'

// Runtime shape of a persisted user
/** Runtime shape of a persisted user. */
interface UserAttributes extends BaseAttributes {
  name: string
  email: string
  password?: string
}
// Data shape at creation time
/** Fields required at creation time, including the plaintext password. */
interface UserCreationAttributes extends BaseCreationAttributes {
  // Business fields required at creation
  name: string
  email: string
  password: string
}

// Stored bcrypt hashes may be re-validated, but new input must pass the plaintext rules
const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/
// Tracks hashes produced by the hooks so the validator can accept re-saved hashes.
const generatedHashes = new WeakMap<User, string>()

/** Persisted user account; the `password` column stores a bcrypt hash. */
@Table({ tableName: 'users', modelName: 'User' })
export class User extends BaseModel<UserAttributes, UserCreationAttributes> {
  @AllowNull(false)
  @Length({ min: 2, max: 20 })
  @Column({
    type: DataType.STRING,
    comment: 'User name'
  })
  declare name: string

  @Unique
  @AllowNull(false)
  @IsEmail
  @Column({
    type: DataType.STRING,
    comment: 'Email'
  })
  declare email: string

  @AllowNull(false)
  @Validate({
    // Cannot use @Length: the stored value is a 60-char bcrypt hash, which the 30-char cap would wrongly reject when re-saving the instance
    password(this: User, value: string): void {
      if (generatedHashes.get(this) === value) return
      if (!this.isNewRecord && !this.changed('password') && BCRYPT_HASH_PATTERN.test(value)) return
      if (!isValidPlaintextPassword(value)) {
        throw new Error('密码必须为 8 到 30 个字符，且 UTF-8 编码不超过 72 字节')
      }
    }
  })
  @Column({
    type: DataType.STRING,
    comment: 'Password hash'
  })
  // Use declare to avoid useDefineForClassFields generating instance fields that shadow Sequelize's getters/setters
  declare password: string

  @HasMany(() => Notebook)
  declare notebooks?: Notebook[]

  // Auto-hashing hooks
  /** Hashes a changed password with bcrypt before create or update. */
  @BeforeCreate
  @BeforeUpdate
  static async hashPassword(instance: User): Promise<void> {
    if (instance.changed('password')) {
      const salt = await bcrypt.genSalt(10)
      instance.password = await bcrypt.hash(instance.password, salt)
      generatedHashes.set(instance, instance.password)
    }
  }

  /** Verifies a plaintext candidate against the stored bcrypt hash. */
  async comparePassword(candidatePassword: string): Promise<boolean> {
    return bcrypt.compare(candidatePassword, this.password)
  }

  // Override toJSON
  // Ensure that no matter who calls user.toJSON(), the password is never sent to the frontend
  /** Serializes the user without the password, safe to expose to the frontend. */
  toJSON(): object {
    const values = Object.assign({}, this.get())
    delete values.password
    return values
  }
}
