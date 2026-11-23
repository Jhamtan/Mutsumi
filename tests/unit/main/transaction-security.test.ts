import { afterEach, describe, expect, it, vi } from 'vitest'
import { Sequelize, Transaction } from 'sequelize'
import {
  registerTransactionGuard,
  withReadSnapshot,
  withTransaction
} from '../../../src/main/database/transaction'

const ambient = vi.hoisted(() => ({ transaction: undefined as unknown }))
vi.mock('cls-hooked', () => ({
  createNamespace: () => ({
    get: (name: string) => (name === 'transaction' ? ambient.transaction : undefined),
    bind: (fn: unknown) => fn,
    run: (fn: () => unknown) => fn()
  })
}))
afterEach(() => {
  ambient.transaction = undefined
})

function fakeDatabase() {
  const transaction = {} as Transaction
  const states: string[] = []
  const begin = vi.fn(
    async (_options: unknown, operation: (transaction: Transaction) => Promise<unknown>) => {
      const previous = ambient.transaction
      ambient.transaction = transaction
      try {
        const result = await operation(transaction)
        states.push('commit')
        return result
      } catch (error) {
        states.push('rollback')
        throw error
      } finally {
        ambient.transaction = previous
      }
    }
  )
  return { sequelize: { transaction: begin } as unknown as Sequelize, transaction, begin, states }
}

describe('transaction authorization guards', () => {
  it('opens IMMEDIATE writes and DEFERRED read snapshots', async () => {
    const write = fakeDatabase()
    expect(await withTransaction(write.sequelize, async () => 1)).toBe(1)
    expect(write.begin.mock.calls[0][0]).toMatchObject({ type: Transaction.TYPES.IMMEDIATE })
    const read = fakeDatabase()
    expect(await withReadSnapshot(read.sequelize, async () => 2)).toBe(2)
    expect(read.begin.mock.calls[0][0]).toMatchObject({ type: Transaction.TYPES.DEFERRED })
  })

  it('does not open or independently commit nested CLS transactions', async () => {
    const database = fakeDatabase()
    await withTransaction(database.sequelize, async (outer) => {
      await withTransaction(database.sequelize, async (inner) => {
        expect(inner).toBe(outer)
      })
      await withReadSnapshot(database.sequelize, async (inner) => {
        expect(inner).toBe(outer)
      })
      expect(database.states).toEqual([])
    })
    expect(database.begin).toHaveBeenCalledTimes(1)
    expect(database.states).toEqual(['commit'])
  })

  it('reuses an explicit transaction without creating a new one', async () => {
    const database = fakeDatabase()
    expect(
      await withTransaction(
        database.sequelize,
        async (inner) => {
          expect(inner).toBe(database.transaction)
          return 3
        },
        database.transaction
      )
    ).toBe(3)
    expect(database.begin).not.toHaveBeenCalled()
  })

  it('rolls back the outer write when authorization expires after a nested mutation', async () => {
    const database = fakeDatabase()
    let active = true
    const guard = vi.fn(() => {
      if (!active) throw new Error('operation revoked')
    })
    const result = withTransaction(database.sequelize, async () => {
      await withTransaction(database.sequelize, async (inner) => {
        registerTransactionGuard(inner, guard)
        guard()
      })
      active = false
      return 'staged write'
    })
    await expect(result).rejects.toThrow('operation revoked')
    expect(guard).toHaveBeenCalledTimes(2)
    expect(database.states).toEqual(['rollback'])
  })

  it('deduplicates guards and checks every guard before the outer commit', async () => {
    const database = fakeDatabase()
    const a = vi.fn()
    const b = vi.fn()
    await withTransaction(database.sequelize, async (transaction) => {
      registerTransactionGuard(transaction, a)
      registerTransactionGuard(transaction, a)
      registerTransactionGuard(transaction, b)
      registerTransactionGuard(transaction)
      expect(a).not.toHaveBeenCalled()
      return true
    })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(database.states).toEqual(['commit'])
  })
})
