/**
 * Log-safe extraction of database error details: exposes only fixed error types
 * and sanitized SQLite error codes, never SQL, params, messages or causes.
 */
import { BaseError, DatabaseError } from 'sequelize'

// Log only fixed error types and database error codes; never SQL, params, message, stack or cause
/**
 * Reduces an arbitrary error to `{ errorType, code? }`, allowing only known
 * Sequelize error names through and only `SQLITE_*` error codes from a
 * DatabaseError's parent.
 */
export function databaseErrorDetails(error: unknown): { errorType: string; code?: string } {
  const knownTypes = new Set([
    'SequelizeDatabaseError',
    'SequelizeTimeoutError',
    'SequelizeConnectionError',
    'SequelizeForeignKeyConstraintError'
  ])
  const errorType =
    error instanceof BaseError && knownTypes.has(error.name) ? error.name : 'UnknownError'
  const code =
    error instanceof DatabaseError ? (error.parent as Error & { code?: unknown }).code : null
  return {
    errorType,
    ...(typeof code === 'string' && /^SQLITE_[A-Z_]+$/.test(code) ? { code } : {})
  }
}
