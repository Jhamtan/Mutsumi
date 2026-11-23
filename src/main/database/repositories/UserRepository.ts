/**
 * Repository for user records, exposing email lookups used during login.
 */
import { BaseRepository } from './BaseRepository'
import { User } from '../models/user.model'
import type { CreateUserDTO } from '@common/types'
import type { Transaction } from 'sequelize'

type EmailLookupOptions = { transaction?: Transaction; paranoid?: boolean }

/** Data access for users; writable fields are name, email and password. */
export default class UserRepository extends BaseRepository<User, CreateUserDTO> {
  constructor() {
    super(User, ['name', 'email', 'password'])
  }

  /** Loads an active user by email for login (delegates to findByEmail). */
  async findUserForLogin(email: string): Promise<User | null> {
    return this.findByEmail(email)
  }

  /** Reads only public fields for the already authenticated sender's session. */
  async findForSession(userId: number): Promise<User | null> {
    try {
      return await this.model.findByPk(userId, {
        attributes: ['id', 'name', 'email', 'createdAt', 'updatedAt'],
        paranoid: true,
        logging: false
      })
    } catch (error) {
      return this.handleError(error)
    }
  }

  /** Finds a non-deleted user by email, honoring an optional transaction/paranoid mode. */
  async findByEmail(email: string, options?: EmailLookupOptions): Promise<User | null> {
    try {
      return await this.model.findOne({
        where: { email },
        transaction: options?.transaction,
        paranoid: options?.paranoid ?? true,
        logging: false
      })
    } catch (error) {
      return this.handleError(error)
    }
  }
}
