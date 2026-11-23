/**
 * Shared user-account password policy.
 *
 * These limits are reused by the main-process Zod schemas so the renderer and
 * main process enforce identical rules.
 */
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 30
export const PASSWORD_MAX_BYTES = 72

// bcrypt only processes the first 72 UTF-8 bytes; a character-count limit cannot substitute for a byte-count limit
/**
 * Type guard for plaintext user-account passwords. Enforces both the
 * character-count range and the UTF-8 byte cap so bcrypt never sees a
 * truncated password.
 */
export function isValidPlaintextPassword(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= PASSWORD_MIN_LENGTH &&
    value.length <= PASSWORD_MAX_LENGTH &&
    new TextEncoder().encode(value).length <= PASSWORD_MAX_BYTES
  )
}
