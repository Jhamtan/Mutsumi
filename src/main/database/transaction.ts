/**
 * Transaction helpers that reuse an ambient CLS transaction when one exists and
 * otherwise open SQLite transactions with the appropriate lock mode.
 */
import { Sequelize, Transaction } from 'sequelize'
import * as cls from 'cls-hooked'

const namespace = cls.createNamespace('myappspace')
Sequelize.useCLS(namespace)

const commitGuards = new WeakMap<Transaction, Set<() => void>>()

/** Nested services register authorization checks on the shared outer transaction. */
export function registerTransactionGuard(transaction: Transaction, guard?: () => void): void {
  if (!guard) return
  let guards = commitGuards.get(transaction)
  if (!guards) {
    guards = new Set()
    commitGuards.set(transaction, guards)
  }
  guards.add(guard)
}

function guardedOperation<T>(
  operation: (transaction: Transaction) => Promise<T>
): (transaction: Transaction) => Promise<T> {
  return async (transaction) => {
    const result = await operation(transaction)
    // This is the last cancellable authorization decision before Sequelize sends COMMIT.
    // A guard thrown here rolls back every nested mutation. Revocation after this
    // decision may suppress the response, but cannot undo an already-started COMMIT.
    for (const guard of commitGuards.get(transaction) ?? []) guard()
    return result
  }
}

/**
 * Runs `operation` within a consistent read snapshot. When an active transaction
 * exists it is reused; otherwise a DEFERRED transaction takes the snapshot on
 * first read without acquiring a write lock up front.
 */
export function withReadSnapshot<T>(
  sequelize: Sequelize,
  operation: (transaction: Transaction) => Promise<T>,
  transaction?: Transaction
): Promise<T> {
  const activeTransaction = transaction ?? (namespace.get('transaction') as Transaction | undefined)
  if (activeTransaction) return operation(activeTransaction)

  // DEFERRED establishes the SQLite snapshot on first read without taking a write lock up front.
  return sequelize.transaction(
    { type: Transaction.TYPES.DEFERRED, logging: false },
    guardedOperation(operation)
  )
}

/**
 * Runs `operation` within a write transaction. When an active transaction exists
 * it is reused; otherwise an IMMEDIATE transaction acquires the SQLite write
 * lock before reading, avoiding lock upgrades during read-then-write flows.
 */
export function withTransaction<T>(
  sequelize: Sequelize,
  operation: (transaction: Transaction) => Promise<T>,
  transaction?: Transaction
): Promise<T> {
  // Prefer reusing an explicit or CLS transaction so nested repository calls do not open independent transactions that commit early
  const activeTransaction = transaction ?? (namespace.get('transaction') as Transaction | undefined)
  if (activeTransaction) return operation(activeTransaction)

  // SQLite acquires the write lock before reading, avoiding races when upgrading locks during read-then-write flows; exceptions are rolled back automatically by the managed transaction
  return sequelize.transaction(
    { type: Transaction.TYPES.IMMEDIATE, logging: false },
    guardedOperation(operation)
  )
}
