/** User authentication IPC: register, login and idempotent logout. */
import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type { User } from '../../database/models/user.model'
import type { LoginPreferenceResultDTO } from '../../../common/types'
import RememberedAccountService from '../../services/RememberedAccountService'
import { randomBytes } from 'node:crypto'
import * as bcrypt from 'bcryptjs'
import { z } from 'zod'
import { CreateUserSchema, CreateUserInput, LoginSchema, RememberedLoginSchema } from '../schemas'
import { handleRevocation, handleWithValidation } from '../validator'
import UserRepository from '../../database/repositories/UserRepository'
import { AppError } from '../../errors'
import {
  beginAuthentication,
  captureSender,
  captureSession,
  clearSession,
  setSession,
  type OperationGuard
} from '../security'
import { registerTransactionGuard } from '../../database/transaction'

const userRepo = new UserRepository()
const rememberedAccount = new RememberedAccountService()
// Same bcrypt cost as a real account; the random secret is only used for timing-equal comparisons against unknown accounts, never to create one.
const dummyPasswordHash = bcrypt.hash(randomBytes(32).toString('hex'), 10)
const MAX_AUTH_PAYLOAD_BYTES = 16 * 1024
const loginRateLimit = { bucket: 'auth:login', maxRequests: 8, windowMs: 60_000 }

function publicUser(user: User): Record<string, unknown> {
  const values = user.toJSON()
  const result: Record<string, unknown> = {}
  for (const field of ['id', 'name', 'email', 'createdAt', 'updatedAt']) {
    if (!Object.prototype.hasOwnProperty.call(values, field)) continue
    const value: unknown = Reflect.get(values, field)
    result[field] = value instanceof Date ? value.toISOString() : value
  }
  if (Number.isSafeInteger(user.id) && user.id > 0) result.id = user.id
  return result
}

async function verifyUser(email: string, password: string, guard: OperationGuard): Promise<User> {
  const user = await userRepo.findUserForLogin(email)
  guard()
  const matched = user
    ? await user.comparePassword(password)
    : await bcrypt.compare(password, await dummyPasswordHash)
  guard()
  if (!user || !matched) throw new AppError('Invalid email or password', 'AUTH_FAILED')
  return user
}

async function updateRememberedAccount(
  remember: boolean | undefined,
  email: string,
  password: string,
  guard: OperationGuard
): Promise<LoginPreferenceResultDTO | undefined> {
  if (remember === undefined) return undefined
  try {
    if (remember) await rememberedAccount.remember(email, password, guard)
    else await rememberedAccount.clear(guard)
    guard()
    return { saved: remember }
  } catch (error) {
    // Storage failure must not turn a verified login into a false authentication failure.
    // Revocation still propagates and prevents establishing any session.
    guard()
    return {
      saved: false,
      error:
        error instanceof AppError && error.code === 'REMEMBERED_ACCOUNT_UNAVAILABLE'
          ? 'unavailable'
          : 'storage-failed'
    }
  }
}

function completeLogin(
  event: IpcMainInvokeEvent,
  user: User,
  data: Record<string, unknown>,
  preference: LoginPreferenceResultDTO | undefined,
  guard: OperationGuard
): Record<string, unknown> {
  guard()
  setSession(event, user.id, guard)
  return preference ? { ...data, rememberedAccount: preference } : data
}

export function registerAuthHandlers(): void {
  ipcMain.handle(
    'user:create',
    handleWithValidation(
      CreateUserSchema,
      async (data: CreateUserInput, event) => {
        const assertActive = captureSender(event)
        try {
          return await userRepo.transaction(async (transaction) => {
            registerTransactionGuard(transaction, assertActive)
            assertActive()
            // The existence check and creation share a transaction; soft-deleted emails remain reserved.
            const existing = await userRepo.findByEmail(data.email, {
              transaction,
              paranoid: false
            })
            assertActive()
            if (existing) {
              throw new AppError('Email already exists', 'EMAIL_EXISTS')
            }

            const user = await userRepo.create(data, { transaction })
            assertActive()
            return publicUser(user)
          })
        } catch (error) {
          if (error instanceof AppError && error.code === 'DATA_EXISTS') {
            throw new AppError('Email already exists', 'EMAIL_EXISTS')
          }
          throw error
        }
      },
      {
        maxPayloadBytes: MAX_AUTH_PAYLOAD_BYTES,
        rateLimit: { bucket: 'auth:register', maxRequests: 4, windowMs: 60_000 }
      }
    )
  )

  ipcMain.handle(
    'user:login',
    handleWithValidation(
      LoginSchema,
      async (data, event) => {
        const assertCurrentAttempt = beginAuthentication(event)
        const user = await verifyUser(data.email, data.password, assertCurrentAttempt)
        const result = publicUser(user)
        const preference = await updateRememberedAccount(
          data.rememberAccount,
          data.email,
          data.password,
          assertCurrentAttempt
        )
        return completeLogin(event, user, result, preference, assertCurrentAttempt)
      },
      {
        maxPayloadBytes: MAX_AUTH_PAYLOAD_BYTES,
        rateLimit: loginRateLimit
      }
    )
  )

  ipcMain.handle(
    'user:session',
    handleWithValidation(
      z.undefined(),
      async (_data, event) => {
        const { userId, assertActive } = captureSession(event)
        const user = await userRepo.findForSession(userId)
        assertActive()
        if (!user || user.id !== userId) {
          clearSession(event)
          throw new AppError('Authentication required.', 'AUTH_REQUIRED')
        }
        const result = publicUser(user)
        assertActive()
        // Read the existing main-process session; never reinstall identity or keys.
        return result
      },
      { requireAuth: true, maxPayloadBytes: 4 * 1024 }
    )
  )

  ipcMain.handle(
    'user:logout',
    handleRevocation(z.undefined(), (_data, event) => {
      clearSession(event)
      return null
    })
  )

  ipcMain.handle(
    'user:remembered-account',
    handleWithValidation(
      z.undefined(),
      async (_data, event) => rememberedAccount.getInfo(captureSender(event)),
      {
        maxPayloadBytes: 4 * 1024,
        rateLimit: { bucket: 'auth:preferences', maxRequests: 30, windowMs: 60_000 }
      }
    )
  )

  ipcMain.handle(
    'user:login-remembered',
    handleWithValidation(
      RememberedLoginSchema,
      async (data, event) => {
        const guard = beginAuthentication(event)
        const verified = await rememberedAccount.useRemembered(
          data.email,
          guard,
          async (email, password) => {
            const user = await verifyUser(email, password, guard)
            const result = publicUser(user)
            const preference = await updateRememberedAccount(
              data.rememberAccount ?? true,
              email,
              password,
              guard
            )
            return { user, result, preference }
          }
        )
        // Finish the guarded storage callback before our own successful login changes the epoch.
        return completeLogin(event, verified.user, verified.result, verified.preference, guard)
      },
      { maxPayloadBytes: 4 * 1024, rateLimit: loginRateLimit }
    )
  )

  ipcMain.handle(
    'user:forget-remembered-account',
    handleWithValidation(
      z.undefined(),
      async (_data, event) => {
        await rememberedAccount.clear(captureSender(event))
        return null
      },
      { maxPayloadBytes: 4 * 1024 }
    )
  )
}
