/**
 * Notebook lifecycle service: creates a notebook with a wrapped data key and
 * unlocks it back to a plaintext data key, zeroing keys on any failure.
 */
import { randomUUID } from 'node:crypto'
import type { NotebookSummaryDTO } from '@common/diary'
import { AppError } from '../errors'
import {
  createDataKey,
  unwrapDataKey,
  wrapDataKey,
  type NotebookKeyEnvelope
} from '../crypto/notebook-crypto'
import type { Notebook } from '../database/models/notebook.model'
import NotebookRepository from '../database/repositories/NotebookRepository'
import { registerTransactionGuard } from '../database/transaction'

/** Manages notebook persistence, key wrapping, and ownership checks. */
export class NotebookService {
  constructor(private readonly notebooks = new NotebookRepository()) {}

  /**
   * Creates a notebook and wraps a freshly generated data key under the user's
   * password (via scrypt). The plaintext data key is returned for use this
   * session and is zeroed if persistence fails.
   */
  async create(
    userId: number,
    name: string,
    password: string,
    guard?: () => void
  ): Promise<{ dto: NotebookSummaryDTO; dataKey: Buffer }> {
    guard?.()
    const uuid = randomUUID()
    const dataKey = createDataKey()
    try {
      guard?.()
      const envelope = await wrapDataKey(password, uuid, dataKey)
      guard?.()
      const notebook = await this.notebooks.transaction(async (transaction) => {
        registerTransactionGuard(transaction, guard)
        guard?.()
        const created = await this.notebooks.create(
          { uuid, userId, name, ...envelope },
          { transaction }
        )
        guard?.()
        return created
      })
      guard?.()
      return { dto: this.toSummary(notebook), dataKey }
    } catch (error) {
      dataKey.fill(0)
      throw error
    }
  }

  async list(userId: number, guard?: () => void): Promise<NotebookSummaryDTO[]> {
    guard?.()
    const notebooks = await this.notebooks.findAllOwned(userId)
    guard?.()
    return notebooks.map((notebook) => this.toSummary(notebook))
  }

  /** Loads a notebook owned by the user, or throws NOTEBOOK_NOT_FOUND. */
  async requireOwned(userId: number, notebookId: number, guard?: () => void): Promise<Notebook> {
    guard?.()
    const notebook = await this.notebooks.findOwnedById(userId, notebookId)
    guard?.()
    if (!notebook) throw new AppError('Notebook not found.', 'NOTEBOOK_NOT_FOUND')
    return notebook
  }

  /** Authenticates the password and recovers the notebook's data key. */
  async unlock(
    userId: number,
    notebookId: number,
    password: string,
    guard?: () => void
  ): Promise<{ dto: NotebookSummaryDTO; dataKey: Buffer }> {
    guard?.()
    const notebook = await this.requireOwned(userId, notebookId, guard)
    guard?.()
    const dataKey = await unwrapDataKey(password, notebook.uuid, this.envelope(notebook))
    try {
      guard?.()
      return { dto: this.toSummary(notebook), dataKey }
    } catch (error) {
      dataKey.fill(0)
      throw error
    }
  }

  toSummary(notebook: Notebook, guard?: () => void): NotebookSummaryDTO {
    guard?.()
    return {
      id: notebook.id,
      uuid: notebook.uuid,
      name: notebook.name,
      createdAt: notebook.createdAt.toISOString(),
      updatedAt: notebook.updatedAt.toISOString()
    }
  }

  /** Maps a notebook row's crypto columns back into a {@link NotebookKeyEnvelope}. */
  envelope(notebook: Notebook, guard?: () => void): NotebookKeyEnvelope {
    guard?.()
    return {
      cryptoVersion: notebook.cryptoVersion,
      kdfAlgorithm: notebook.kdfAlgorithm as NotebookKeyEnvelope['kdfAlgorithm'],
      kdfSalt: notebook.kdfSalt,
      kdfN: notebook.kdfN,
      kdfR: notebook.kdfR,
      kdfP: notebook.kdfP,
      wrappedKey: notebook.wrappedKey,
      wrappedKeyNonce: notebook.wrappedKeyNonce,
      wrappedKeyTag: notebook.wrappedKeyTag
    }
  }
}

export default NotebookService
