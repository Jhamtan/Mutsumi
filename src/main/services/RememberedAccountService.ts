import * as electron from 'electron'
import { constants, type Stats } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { RememberedAccountInfoDTO } from '../../common/types'
import { AppError } from '../errors'
import { LoginSchema } from '../ipc/schemas'

export interface RememberedAccountEncryption {
  isAvailable(): Promise<boolean>
  encrypt(value: string): Promise<Buffer>
  decrypt(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
}

type Guard = (() => void) | undefined
type Failure = 'UNAVAILABLE' | 'MISSING' | 'DAMAGED' | 'STORAGE_FAILED'
type Credentials = z.infer<typeof credentialsSchema>

const FILE_NAME = 'remembered-account.v1.json'
const MAX_RECORD_BYTES = 16 * 1024
const MAX_CIPHERTEXT_BYTES = 8 * 1024
const MAX_PLAINTEXT_LENGTH = 2048
const credentialsSchema = LoginSchema.pick({ email: true, password: true }).strict()
const emailSchema = LoginSchema.pick({ email: true }).strict()
const recordSchema = z
  .object({
    version: z.literal(1),
    ciphertext: z
      .string()
      .min(4)
      .max(Math.ceil(MAX_CIPHERTEXT_BYTES / 3) * 4)
  })
  .strict()
const secureLinuxBackends = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])
const messages: Record<Failure, string> = {
  UNAVAILABLE: '系统安全加密暂不可用',
  MISSING: '没有匹配的已保存账号',
  DAMAGED: '已保存的账号资料损坏',
  STORAGE_FAILED: '无法读写已保存的账号资料'
}

class RememberedAccountError extends AppError {}

function failure(code: Failure): AppError {
  return new RememberedAccountError(messages[code], `REMEMBERED_ACCOUNT_${code}`)
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isRegularFile(stat: Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
}

export class RememberedAccountService {
  private readonly directory: () => string
  private readonly encryption: RememberedAccountEncryption
  private pending: Promise<void> = Promise.resolve()

  constructor(
    options: {
      directory?: () => string
      encryption?: RememberedAccountEncryption
      /** Used only in unit tests to determine the platform for the default encryption adapter. */
      platform?: () => NodeJS.Platform
    } = {}
  ) {
    this.directory = options.directory ?? (() => electron.app.getPath('userData'))
    const platform = options.platform ?? (() => process.platform)
    this.encryption = options.encryption ?? {
      isAvailable: async () => {
        const available = await electron.safeStorage.isAsyncEncryptionAvailable()
        return (
          available &&
          (platform() === 'win32' ||
            platform() === 'darwin' ||
            (platform() === 'linux' &&
              secureLinuxBackends.has(electron.safeStorage.getSelectedStorageBackend())))
        )
      },
      encrypt: (value) => electron.safeStorage.encryptStringAsync(value),
      decrypt: (value) => electron.safeStorage.decryptStringAsync(value)
    }
  }

  async getInfo(guard?: () => void): Promise<RememberedAccountInfoDTO> {
    return this.serial(guard, async () => {
      const empty = (
        recordStatus: RememberedAccountInfoDTO['recordStatus']
      ): RememberedAccountInfoDTO => ({
        email: '',
        hasSavedPassword: false,
        encryptionAvailable: recordStatus !== 'unavailable',
        recordStatus
      })
      if (!(await this.available(guard))) return empty('unavailable')
      try {
        const credentials = await this.readCredentials(guard)
        guard?.()
        return {
          email: credentials.email,
          hasSavedPassword: true,
          encryptionAvailable: true,
          recordStatus: 'saved'
        }
      } catch (error) {
        guard?.()
        if (error instanceof RememberedAccountError) {
          if (error.code === 'REMEMBERED_ACCOUNT_MISSING') return empty('none')
          if (error.code === 'REMEMBERED_ACCOUNT_DAMAGED') return empty('damaged')
          if (error.code === 'REMEMBERED_ACCOUNT_UNAVAILABLE') return empty('unavailable')
        }
        throw error
      }
    })
  }

  async remember(email: string, password: string, guard?: () => void): Promise<void> {
    return this.serial(guard, async () => {
      const parsed = credentialsSchema.safeParse({ email, password })
      if (!parsed.success) throw failure('STORAGE_FAILED')
      if (!(await this.available(guard))) throw failure('UNAVAILABLE')
      const ciphertext = await this.perform(
        () => this.encryption.encrypt(JSON.stringify(parsed.data)),
        guard,
        'STORAGE_FAILED'
      )
      let record: Buffer | undefined
      let handle: FileHandle | undefined
      let temporaryPath: string | undefined
      let ownsTemporaryFile = false
      try {
        guard?.()
        if (ciphertext.length === 0 || ciphertext.length > MAX_CIPHERTEXT_BYTES) {
          throw failure('STORAGE_FAILED')
        }
        record = Buffer.from(
          JSON.stringify({ version: 1, ciphertext: ciphertext.toString('base64') })
        )
        const directory = this.storageDirectory(guard)
        await this.perform(() => fs.mkdir(directory, { recursive: true, mode: 0o700 }), guard)
        guard?.()
        const directoryStat = await this.stat(directory, guard)
        if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) {
          throw failure('STORAGE_FAILED')
        }
        const target = join(directory, FILE_NAME)
        await this.checkTarget(target, guard)
        temporaryPath = join(directory, `${FILE_NAME}.${randomUUID()}.tmp`)
        handle = await this.perform(() => fs.open(temporaryPath!, 'wx', 0o600), guard)
        ownsTemporaryFile = true
        guard?.()
        await this.perform(() => handle!.writeFile(record!), guard)
        guard?.()
        await this.perform(() => handle!.sync(), guard)
        guard?.()
        await this.perform(() => handle!.close(), guard)
        handle = undefined
        guard?.()
        await this.checkTarget(target, guard)
        await this.perform(() => fs.rename(temporaryPath!, target), guard)
        ownsTemporaryFile = false
        // A native write that has already started cannot be undone; cancellation only prevents returning success.
        guard?.()
      } finally {
        record?.fill(0)
        ciphertext.fill(0)
        if (handle) await handle.close().catch(() => undefined)
        if (ownsTemporaryFile && temporaryPath) {
          await fs.unlink(temporaryPath).catch(() => undefined)
        }
      }
    })
  }

  async useRemembered<T>(
    email: string,
    guard: Guard,
    operation: (email: string, password: string) => Promise<T>
  ): Promise<T> {
    const credentials = await this.serial(guard, async () => {
      const parsed = emailSchema.safeParse({ email })
      if (!parsed.success) throw failure('MISSING')
      if (!(await this.available(guard))) throw failure('UNAVAILABLE')
      const saved = await this.readCredentials(guard)
      guard?.()
      if (saved.email !== parsed.data.email) throw failure('MISSING')
      return saved
    })
    // The external auth callback does not hold the storage queue, so it may re-save or clear the record.
    guard?.()
    try {
      return await operation(credentials.email, credentials.password)
    } finally {
      guard?.()
    }
  }

  async clear(guard?: () => void): Promise<void> {
    return this.serial(guard, async () => {
      const target = join(this.storageDirectory(guard), FILE_NAME)
      if (!(await this.checkTarget(target, guard))) return
      guard?.()
      try {
        await fs.unlink(target)
      } catch (error) {
        guard?.()
        if (!isMissing(error)) throw failure('STORAGE_FAILED')
      }
      guard?.()
    })
  }

  private serial<T>(guard: Guard, operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(async () => {
      guard?.()
      try {
        return await operation()
      } finally {
        guard?.()
      }
    })
    this.pending = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  private async available(guard: Guard): Promise<boolean> {
    guard?.()
    let available = false
    try {
      available = await this.encryption.isAvailable()
    } catch {
      // Do not expose system details of a native encryption error over IPC.
    }
    guard?.()
    return available
  }

  private storageDirectory(guard: Guard): string {
    guard?.()
    let directory: string
    try {
      directory = this.directory()
      if (!directory) throw failure('STORAGE_FAILED')
    } catch {
      guard?.()
      throw failure('STORAGE_FAILED')
    }
    guard?.()
    return directory
  }

  // After a Buffer/handle is returned, the caller enters a finally guard first, then re-checks the guard.
  private async perform<T>(
    operation: () => Promise<T>,
    guard: Guard,
    code: Failure = 'STORAGE_FAILED'
  ): Promise<T> {
    guard?.()
    try {
      return await operation()
    } catch {
      guard?.()
      throw failure(code)
    }
  }

  private async stat(path: string, guard: Guard): Promise<Stats | null> {
    guard?.()
    let result: Stats | null
    try {
      result = await fs.lstat(path)
    } catch (error) {
      guard?.()
      if (!isMissing(error)) throw failure('STORAGE_FAILED')
      result = null
    }
    guard?.()
    return result
  }

  private async checkTarget(path: string, guard: Guard): Promise<Stats | null> {
    const stat = await this.stat(path, guard)
    if (stat && !isRegularFile(stat)) throw failure('STORAGE_FAILED')
    return stat
  }

  private async readCredentials(guard: Guard): Promise<Credentials> {
    const target = join(this.storageDirectory(guard), FILE_NAME)
    const stat = await this.stat(target, guard)
    if (!stat) throw failure('MISSING')
    if (!isRegularFile(stat) || stat.size === 0 || stat.size > MAX_RECORD_BYTES) {
      throw failure('DAMAGED')
    }
    // Open with O_NOFOLLOW and re-stat the handle to confirm the file did not change under us.
    const handle = await this.perform(
      () => fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)),
      guard,
      'DAMAGED'
    )
    let raw: Buffer | undefined
    let ciphertext: Buffer | undefined
    try {
      guard?.()
      const openedStat = await this.perform(() => handle.stat(), guard)
      guard?.()
      if (
        !isRegularFile(openedStat) ||
        openedStat.dev !== stat.dev ||
        openedStat.ino !== stat.ino ||
        openedStat.size !== stat.size
      ) {
        throw failure('DAMAGED')
      }
      // Read with a fixed cap so a file growing after lstat cannot cause an unbounded readFile allocation.
      raw = Buffer.alloc(MAX_RECORD_BYTES + 1)
      let length = 0
      while (length < raw.length) {
        const read = await this.perform(
          () => handle.read(raw!, length, raw!.length - length, length),
          guard
        )
        guard?.()
        if (read.bytesRead === 0) break
        length += read.bytesRead
      }
      if (length !== stat.size || length > MAX_RECORD_BYTES) throw failure('DAMAGED')
      let record: z.infer<typeof recordSchema>
      try {
        record = recordSchema.parse(JSON.parse(raw.toString('utf8', 0, length)))
      } catch {
        throw failure('DAMAGED')
      }
      raw.fill(0)
      if (record.ciphertext.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(record.ciphertext)) {
        throw failure('DAMAGED')
      }
      // Validate the stored ciphertext, then decrypt and re-validate the plaintext credentials.
      ciphertext = Buffer.from(record.ciphertext, 'base64')
      if (
        ciphertext.length === 0 ||
        ciphertext.length > MAX_CIPHERTEXT_BYTES ||
        ciphertext.toString('base64') !== record.ciphertext
      ) {
        throw failure('DAMAGED')
      }
      if (!(await this.available(guard))) throw failure('UNAVAILABLE')
      const decrypted = await this.perform(
        () => this.encryption.decrypt(ciphertext!),
        guard,
        'DAMAGED'
      )
      guard?.()
      if (decrypted.result.length > MAX_PLAINTEXT_LENGTH) throw failure('DAMAGED')
      try {
        return credentialsSchema.parse(JSON.parse(decrypted.result))
      } catch {
        throw failure('DAMAGED')
      }
    } finally {
      // Only wipe inputs after the native Promise completes; JS strings cannot be reliably zeroed.
      raw?.fill(0)
      ciphertext?.fill(0)
      await handle.close().catch(() => undefined)
    }
  }
}

export default RememberedAccountService
