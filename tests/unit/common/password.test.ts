import { describe, expect, it } from 'vitest'
import { isValidPlaintextPassword } from '../../../src/common/password'

/**
 * Tests password length validation, which enforces both a character range and
 * a UTF-8 byte ceiling (bcrypt's 72-byte truncation limit).
 */
describe('isValidPlaintextPassword', () => {
  it.each([undefined, null, 12345678, true, {}, [], new String('password')])(
    'rejects non-string values: %j',
    (value) => {
      expect(isValidPlaintextPassword(value)).toBe(false)
    }
  )

  it.each([
    ['', false],
    ['a'.repeat(7), false],
    ['a'.repeat(8), true],
    ['a'.repeat(30), true],
    ['a'.repeat(31), false]
  ])('enforces character limits for %j', (value, valid) => {
    expect(isValidPlaintextPassword(value)).toBe(valid)
  })

  // 中 is 3 UTF-8 bytes and 😀 is 4, so the 72-byte bcrypt ceiling is crossed
  // between 24 and 25 characters regardless of character count.
  it.each([
    ['中'.repeat(24), true],
    ['中'.repeat(25), false],
    ['😀'.repeat(15), true],
    ['中'.repeat(22) + 'a'.repeat(6), true],
    ['中'.repeat(22) + 'a'.repeat(7), false]
  ])('checks UTF-8 bytes independently of character length: %j', (value, valid) => {
    expect(isValidPlaintextPassword(value)).toBe(valid)
  })
})
