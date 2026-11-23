import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { AppError } from '../../../src/main/errors'
import { handleRevocation, handleWithValidation } from '../../../src/main/ipc/validator'
import logger from '../../../src/main/logger'
import { createIpcEvent } from '../helpers/ipc-event'
import {
  beginAuthentication,
  clearSession,
  lockNotebook,
  requireSession,
  requireUnlockedNotebook,
  setSession,
  unlockNotebook,
  withUnlockedNotebook
} from '../../../src/main/ipc/security'
import { NotebookIdSchema } from '../../../src/main/ipc/schemas'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/**
 * Tests the IPC validation wrapper: async refinement, trust gating, error
 * shaping, and redaction of sensitive input from responses and logs.
 */
vi.mock('../../../src/main/logger', () => ({ default: { error: vi.fn() } }))

// Canonical response returned for unexpected failures, free of any error detail.
const internalError = {
  success: false,
  message: 'An internal system error occurred. Please contact support.',
  code: 'INTERNAL_ERROR'
}

describe('handleWithValidation', () => {
  it('passes transformed data and the event to the handler', async () => {
    const { event } = createIpcEvent()
    const handler = vi.fn(async (value: string) => ({ value }))
    const wrapped = handleWithValidation(z.string().trim(), handler)
    expect(await wrapped(event, '  test  ')).toEqual({ success: true, data: { value: 'test' } })
    expect(handler).toHaveBeenCalledExactlyOnceWith('test', event)
  })

  it('awaits async refinements before invoking the handler', async () => {
    const handler = vi.fn(async () => 'ok')
    const wrapped = handleWithValidation(
      z.string().refine(async (value) => value === 'allowed'),
      handler
    )
    const { event } = createIpcEvent()
    expect(await wrapped(event, 'allowed')).toEqual({ success: true, data: 'ok' })
    expect((await wrapped(event, 'denied')).code).toBe('INVALID_INPUT')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('returns structured field errors without invoking the handler or logging input', async () => {
    const handler = vi.fn(async () => null)
    const wrapped = handleWithValidation(z.object({ email: z.email() }), handler)
    const response = await wrapped(createIpcEvent().event, { email: 'sensitive invalid value' })
    expect(response).toMatchObject({
      success: false,
      code: 'INVALID_INPUT',
      message: 'Validation Failed'
    })
    expect(response.errors).toMatchObject({ properties: { email: { errors: expect.any(Array) } } })
    // Field errors must not echo the rejected input, which may contain secrets.
    expect(JSON.stringify(response)).not.toContain('sensitive invalid value')
    expect(handler).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('checks trust before executing validation or the handler', async () => {
    const refinement = vi.fn(() => true)
    const handler = vi.fn(async () => null)
    const wrapped = handleWithValidation(z.string().refine(refinement), handler)
    expect(await wrapped(createIpcEvent(undefined, false).event, 'input')).toEqual({
      success: false,
      message: 'Untrusted IPC sender.',
      code: 'IPC_FORBIDDEN'
    })
    expect(refinement).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it('returns business errors without reporting an internal failure', async () => {
    const wrapped = handleWithValidation(z.string(), async () => {
      throw new AppError('Email already exists', 'EMAIL_EXISTS')
    })
    expect(await wrapped(createIpcEvent().event, 'input')).toEqual({
      success: false,
      message: 'Email already exists',
      code: 'EMAIL_EXISTS'
    })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it.each(['validation', 'handler'])(
    'contains exceptions from %s and logs no secrets',
    async (stage) => {
      const secret = 'private-password-and-SQL'
      const schema = z.string().transform((value) => {
        if (stage === 'validation') throw new Error(secret)
        return value
      })
      const wrapped = handleWithValidation(schema, async () => {
        throw new Error(secret)
      })
      // Unexpected errors collapse to a fixed message so the secret never reaches a response or log.
      expect(await wrapped(createIpcEvent().event, secret)).toEqual(internalError)
      expect(logger.error).toHaveBeenCalledExactlyOnceWith('[IPC] Operation failed.')
    }
  )

  it('requires authentication before costly validation', async () => {
    const refinement = vi.fn(() => true)
    const handler = vi.fn(async () => null)
    const wrapped = handleWithValidation(z.string().refine(refinement), handler, {
      requireAuth: true
    })
    expect((await wrapped(createIpcEvent().event, 'input')).code).toBe('AUTH_REQUIRED')
    expect(refinement).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects oversized strings before a refinement runs', async () => {
    const refinement = vi.fn(() => true)
    const wrapped = handleWithValidation(z.string().refine(refinement), async () => null, {
      maxPayloadBytes: 32
    })
    expect((await wrapped(createIpcEvent().event, 'x'.repeat(33))).code).toBe('INVALID_INPUT')
    expect(refinement).not.toHaveBeenCalled()
  })

  it('rejects cyclic, non-JSON and structurally excessive inputs', async () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const wrapped = handleWithValidation(z.unknown(), async () => true)
    for (const value of [cyclic, new Date(), Array(5_001).fill(0)]) {
      expect((await wrapped(createIpcEvent().event, value)).code).toBe('INVALID_INPUT')
    }
  })

  it('does not echo custom messages or unknown property names in validation errors', async () => {
    const schema = z.object({ name: z.string().refine(() => false, 'untrusted-message') }).strict()
    const wrapped = handleWithValidation(schema, async () => true)
    const response = await wrapped(createIpcEvent().event, { name: 'value', 'untrusted-key': 1 })
    const serialized = JSON.stringify(response)
    expect(response.code).toBe('INVALID_INPUT')
    expect(serialized).not.toContain('untrusted-message')
    expect(serialized).not.toContain('untrusted-key')
    expect(serialized.length).toBeLessThan(2_000)
  })

  it('flattens nested union errors instead of reflecting nested messages or paths', async () => {
    const schema = z.union([
      z.object({ 'untrusted-field': z.string().refine(() => false, 'nested-secret') }),
      z.object({ name: z.number() })
    ])
    const response = await handleWithValidation(schema, async () => null)(createIpcEvent().event, {
      'untrusted-field': 'value',
      name: 'not a number'
    })
    const serialized = JSON.stringify(response)
    expect(response.code).toBe('INVALID_INPUT')
    expect(serialized).not.toContain('nested-secret')
    expect(serialized).not.toContain('untrusted-field')
    expect(serialized.length).toBeLessThan(2_000)
  })

  it('enforces rate limits independently per window', async () => {
    const wrapped = handleWithValidation(z.undefined(), async () => true, {
      rateLimit: { bucket: 'synthetic-budget', maxRequests: 2, windowMs: 60_000 }
    })
    const { event } = createIpcEvent()
    expect((await wrapped(event, undefined)).success).toBe(true)
    expect((await wrapped(event, undefined)).success).toBe(true)
    expect((await wrapped(event, undefined)).code).toBe('RATE_LIMITED')
    expect((await wrapped(createIpcEvent().event, undefined)).success).toBe(true)
  })

  it('serializes different IPC channels in one window', async () => {
    const entered = deferred()
    const gate = deferred()
    const order: string[] = []
    const first = handleWithValidation(z.undefined(), async () => {
      entered.resolve()
      await gate.promise
      order.push('first')
    })
    const secondHandler = vi.fn(async () => {
      order.push('second')
    })
    const second = handleWithValidation(z.undefined(), secondHandler)
    const { event } = createIpcEvent()
    const pendingFirst = first(event, undefined)
    const pendingSecond = second(event, undefined)
    await entered.promise
    expect(secondHandler).not.toHaveBeenCalled()
    gate.resolve()
    const results = await Promise.all([pendingFirst, pendingSecond])
    expect(results.every((result) => result.success)).toBe(true)
    expect(order).toEqual(['first', 'second'])
  })

  it('bounds pending requests and releases queue reservations', async () => {
    const gate = deferred()
    const wrapped = handleWithValidation(z.undefined(), async () => {
      await gate.promise
      return true
    })
    const { event } = createIpcEvent()
    const pending = Array.from({ length: 16 }, () => wrapped(event, undefined))
    expect((await wrapped(event, undefined)).code).toBe('IPC_BUSY')
    gate.resolve()
    expect((await Promise.all(pending)).every((result) => result.success)).toBe(true)
    expect((await wrapped(event, undefined)).success).toBe(true)
  })

  it('queued requests cannot inherit a replacement account', async () => {
    const entered = deferred()
    const gate = deferred()
    const { event } = createIpcEvent()
    setSession(event, 42)
    const first = handleWithValidation(
      z.undefined(),
      async () => {
        entered.resolve()
        await gate.promise
        return true
      },
      { requireAuth: true }
    )
    const secondHandler = vi.fn(async () => true)
    const second = handleWithValidation(z.undefined(), secondHandler, { requireAuth: true })
    const a = first(event, undefined)
    const b = second(event, undefined)
    await entered.promise
    setSession(event, 99)
    gate.resolve()
    expect((await a).code).toBe('OPERATION_CANCELLED')
    expect((await b).code).toBe('OPERATION_CANCELLED')
    expect(secondHandler).not.toHaveBeenCalled()
  })

  it('rechecks document identity after asynchronous validation', async () => {
    const entered = deferred()
    const gate = deferred()
    const handler = vi.fn(async () => true)
    const wrapped = handleWithValidation(
      z.string().refine(async () => {
        entered.resolve()
        await gate.promise
        return true
      }),
      handler
    )
    const { event, sender } = createIpcEvent()
    const pending = wrapped(event, 'value')
    await entered.promise
    sender.emit('did-start-navigation', {}, '', false, true)
    gate.resolve()
    expect((await pending).code).toBe('OPERATION_CANCELLED')
    expect(handler).not.toHaveBeenCalled()
  })
})

// These independent lifecycle regressions never read the declined auth test files.
describe('synchronous revocation control path', () => {
  const logout = handleRevocation(z.undefined(), (_data, event) => {
    clearSession(event)
    return null
  })
  const lock = handleRevocation(NotebookIdSchema, (data, event) => {
    lockNotebook(event, data.notebookId)
    return null
  })

  it('can lock and log out after the ordinary request rate is exhausted', async () => {
    const { event } = createIpcEvent()
    setSession(event, 42)
    unlockNotebook(event, 10, Buffer.alloc(32, 7))
    const ordinary = handleWithValidation(z.undefined(), async () => true)
    for (let index = 0; index < 120; index++) {
      expect((await ordinary(event, undefined)).success).toBe(true)
    }
    expect((await ordinary(event, undefined)).code).toBe('RATE_LIMITED')
    expect(lock(event, { notebookId: 10 })).toEqual({ success: true, data: null })
    expect(() => requireUnlockedNotebook(event, 10)).toThrow(
      expect.objectContaining({ code: 'NOTEBOOK_LOCKED' })
    )
    expect(logout(event, undefined)).toEqual({ success: true, data: null })
    expect(logout(event, undefined).success).toBe(true)
    expect(() => requireSession(event)).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED' }))
  })

  it('revokes immediately with a full business queue and cancels all prior admissions', async () => {
    const entered = deferred()
    const gate = deferred()
    const { event } = createIpcEvent()
    setSession(event, 42)
    const ordinary = handleWithValidation(z.undefined(), async () => {
      entered.resolve()
      await gate.promise
      return true
    })
    const pending = Array.from({ length: 16 }, () => ordinary(event, undefined))
    await entered.promise
    expect((await ordinary(event, undefined)).code).toBe('IPC_BUSY')
    expect(logout(event, undefined).success).toBe(true)
    expect(() => requireSession(event)).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED' }))
    gate.resolve()
    expect(
      (await Promise.all(pending)).every((response) => response.code === 'OPERATION_CANCELLED')
    ).toBe(true)
    expect((await ordinary(event, undefined)).success).toBe(true)
  })

  it('cancels an active notebook operation and never starts an older queued unlock', async () => {
    const entered = deferred()
    const gate = deferred()
    const { event } = createIpcEvent()
    setSession(event, 42)
    unlockNotebook(event, 10, Buffer.alloc(32, 7))
    let operationKey: Buffer | undefined
    const active = handleWithValidation(
      z.undefined(),
      async () =>
        withUnlockedNotebook(event, 10, async (_userId, key, guard) => {
          operationKey = key
          entered.resolve()
          await gate.promise
          expect(key[0]).toBe(7)
          guard()
          return true
        }),
      { requireAuth: true }
    )
    const unlockHandler = vi.fn(async () => {
      unlockNotebook(event, 10, Buffer.alloc(32, 7))
      return true
    })
    const queuedUnlock = handleWithValidation(z.undefined(), unlockHandler, { requireAuth: true })
    const first = active(event, undefined)
    const second = queuedUnlock(event, undefined)
    await entered.promise
    expect(lock(event, { notebookId: 10 }).success).toBe(true)
    gate.resolve()
    expect((await first).code).toBe('OPERATION_CANCELLED')
    expect((await second).code).toBe('OPERATION_CANCELLED')
    expect(unlockHandler).not.toHaveBeenCalled()
    expect(operationKey).toEqual(Buffer.alloc(32))
    expect(() => requireUnlockedNotebook(event, 10)).toThrow()
  })

  it('does not start an older queued login after an explicit logout', async () => {
    const entered = deferred()
    const gate = deferred()
    const { event } = createIpcEvent()
    const first = handleWithValidation(z.undefined(), async () => {
      entered.resolve()
      await gate.promise
      return true
    })
    const loginHandler = vi.fn(async () => {
      const guard = beginAuthentication(event)
      setSession(event, 42, guard)
      return true
    })
    const login = handleWithValidation(z.undefined(), loginHandler)
    const active = first(event, undefined)
    const queued = login(event, undefined)
    await entered.promise
    expect(logout(event, undefined).success).toBe(true)
    gate.resolve()
    expect((await active).code).toBe('OPERATION_CANCELLED')
    expect((await queued).code).toBe('OPERATION_CANCELLED')
    expect(loginHandler).not.toHaveBeenCalled()
    expect(() => requireSession(event)).toThrow()
  })

  it('still rejects untrusted, malformed and oversized control requests', () => {
    const revoke = vi.fn(() => null)
    const wrapped = handleRevocation(NotebookIdSchema, revoke)
    expect(wrapped(createIpcEvent(undefined, false).event, { notebookId: 10 }).code).toBe(
      'IPC_FORBIDDEN'
    )
    const { event } = createIpcEvent()
    expect(wrapped(event, { notebookId: -1 }).code).toBe('INVALID_INPUT')
    expect(wrapped(event, { notebookId: 10, padding: 'x'.repeat(4_097) }).code).toBe(
      'INVALID_INPUT'
    )
    expect(revoke).not.toHaveBeenCalled()
  })
})
