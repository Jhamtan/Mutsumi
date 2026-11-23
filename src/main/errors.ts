/**
 * Application error types for expected, catchable failures.
 */

// Define a base class for "expected business errors".
/**
 * Base class for expected business errors. The `code` field carries a stable,
 * machine-readable identifier so callers can branch on the error kind without
 * matching on message text.
 */
export class AppError extends Error {
  constructor(
    public message: string,
    public code: string = 'APP_ERROR'
  ) {
    super(message)
    this.name = 'AppError'
  }
}
