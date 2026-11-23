import { describe, expect, it } from 'vitest'
import { CreateUserSchema, LoginSchema } from '../../../src/main/ipc/schemas'

/**
 * Validates the auth Zod schemas: field stripping, name/email length bounds,
 * and the password policy (8–30 characters, at most 72 UTF-8 bytes).
 */
const user = { name: 'Test User', email: 'test@example.com', password: 'password123' }

// Builds an email of exactly `length` characters to probe the 254-character boundary.
function emailOfLength(length: number): string {
  return `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(length - 197)}.com`
}

describe('CreateUserSchema', () => {
  it('accepts valid data and strips fields outside the public contract', () => {
    expect(CreateUserSchema.parse({ ...user, id: 99, role: 'admin' })).toEqual(user)
  })

  it.each([
    ['a', false],
    ['ab', true],
    ['a'.repeat(20), true],
    ['a'.repeat(21), false]
  ])('validates the name length: %j', (name, valid) => {
    expect(CreateUserSchema.safeParse({ ...user, name }).success).toBe(valid)
  })

  it.each(['', 'invalid', 'test@', '@example.com', 'test@example.com '])(
    'rejects an invalid email: %j',
    (email) => {
      expect(CreateUserSchema.safeParse({ ...user, email }).success).toBe(false)
    }
  )

  it.each([null, {}, { name: user.name }, { ...user, password: 12345678 }])(
    'rejects missing or mistyped registration data: %j',
    (input) => {
      expect(CreateUserSchema.safeParse(input).success).toBe(false)
    }
  )

  it('rejects passwords that bcrypt would truncate', () => {
    // 中 is 3 bytes each; 24 fit bcrypt's 72-byte input but 25 would be silently truncated.
    expect(CreateUserSchema.safeParse({ ...user, password: '中'.repeat(24) }).success).toBe(true)
    expect(CreateUserSchema.safeParse({ ...user, password: '中'.repeat(25) }).success).toBe(false)
  })
})

describe('LoginSchema', () => {
  it('enforces the same password policy as registration', () => {
    // 登录与注册一致：8–30 字符、UTF-8 编码不超过 72 字节，避免 bcrypt 截断
    expect(LoginSchema.safeParse({ email: user.email, password: 'password123' }).success).toBe(true)
    expect(LoginSchema.safeParse({ email: user.email, password: '中'.repeat(24) }).success).toBe(
      true
    )
    expect(LoginSchema.safeParse({ email: user.email, password: 'short' }).success).toBe(false)
    expect(LoginSchema.safeParse({ email: user.email, password: '中'.repeat(25) }).success).toBe(
      false
    )
  })

  it.each(['', 'a'.repeat(31), null, 123])('rejects invalid passwords: %j', (password) => {
    expect(LoginSchema.safeParse({ email: user.email, password }).success).toBe(false)
  })
})

it.each([CreateUserSchema, LoginSchema])('bounds email length in both auth schemas', (schema) => {
  expect(schema.safeParse({ ...user, email: emailOfLength(254) }).success).toBe(true)
  expect(schema.safeParse({ ...user, email: emailOfLength(255) }).success).toBe(false)
})
