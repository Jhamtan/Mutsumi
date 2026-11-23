/**
 * Notebook name and notebook-password policy.
 *
 * Unlike user-account passwords, notebook passwords encrypt diary content, so
 * they allow longer values (up to 256 UTF-8 bytes) instead of bcrypt's 72-byte
 * limit.
 */
export const NOTEBOOK_NAME_MIN_LENGTH = 1
export const NOTEBOOK_NAME_MAX_LENGTH = 80
export const NOTEBOOK_PASSWORD_MIN_LENGTH = 8
export const NOTEBOOK_PASSWORD_MAX_LENGTH = 128
export const NOTEBOOK_PASSWORD_MAX_BYTES = 256

/**
 * Type guard for notebook passwords used to encrypt/decrypt a notebook's diary
 * content, validating the character-count range and UTF-8 byte cap above.
 */
export function isValidNotebookPassword(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= NOTEBOOK_PASSWORD_MIN_LENGTH &&
    value.length <= NOTEBOOK_PASSWORD_MAX_LENGTH &&
    new TextEncoder().encode(value).length <= NOTEBOOK_PASSWORD_MAX_BYTES
  )
}
