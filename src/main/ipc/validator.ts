/** Bounded IPC admission, per-window ordering, validation and error redaction. */
import { z } from 'zod'
import type { WebContents } from 'electron'
import logger from '../logger'
import { AppError } from '../errors'
import type { IpcResponse } from '@common/types'
import { assertTrustedSender, captureSender, captureSession } from './security'

export type HandlerOptions = {
  requireAuth?: boolean
  maxPayloadBytes?: number
  rateLimit?: { bucket: string; maxRequests: number; windowMs: number }
}

type QueueState = { tail: Promise<void>; count: number; bytes: number }
type RateBucket = { startedAt: number; requests: number }
const queues = new WeakMap<WebContents, QueueState>()
const rates = new WeakMap<WebContents, Map<string, RateBucket>>()
const MAX_QUEUE_LENGTH = 16
const MAX_QUEUE_BYTES = 160 * 1024 * 1024
const MAX_GLOBAL_QUEUE_BYTES = 256 * 1024 * 1024
const MAX_GLOBAL_QUEUE_LENGTH = 32
const MAX_PAYLOAD_NODES = 5_000
let queuedBytes = 0
let queuedRequests = 0

function invalidPayload(): never {
  throw new AppError('IPC payload exceeds the allowed limits.', 'INVALID_INPUT')
}

/** Count JSON-shaped inputs before any schema refinement or base64 decoding. */
function payloadBytes(input: unknown, limit: number): number {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }]
  const seen = new WeakSet<object>()
  let bytes = 0
  let nodes = 0
  const countString = (value: string): void => {
    if (value.length > limit - bytes) invalidPayload()
    bytes += Buffer.byteLength(value, 'utf8')
    if (bytes > limit) invalidPayload()
  }
  while (pending.length) {
    const { value, depth } = pending.pop()!
    if (++nodes > MAX_PAYLOAD_NODES || depth > 16) invalidPayload()
    if (typeof value === 'string') {
      countString(value)
      continue
    }
    bytes += 8
    if (bytes > limit) invalidPayload()
    if (value == null || typeof value === 'boolean' || typeof value === 'undefined') continue
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalidPayload()
      continue
    }
    if (typeof value !== 'object' || seen.has(value)) invalidPayload()
    seen.add(value)
    if (Array.isArray(value)) {
      if (value.length + nodes + pending.length > MAX_PAYLOAD_NODES) invalidPayload()
      for (const child of value) pending.push({ value: child, depth: depth + 1 })
    } else {
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) invalidPayload()
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue
        if (nodes + pending.length >= MAX_PAYLOAD_NODES) invalidPayload()
        countString(key)
        pending.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 })
      }
    }
  }
  return bytes
}

function consumeRate(sender: WebContents, rule: NonNullable<HandlerOptions['rateLimit']>): void {
  let buckets = rates.get(sender)
  if (!buckets) {
    buckets = new Map()
    rates.set(sender, buckets)
  }
  const now = performance.now()
  let bucket = buckets.get(rule.bucket)
  if (!bucket || now - bucket.startedAt >= rule.windowMs) {
    bucket = { startedAt: now, requests: 0 }
    buckets.set(rule.bucket, bucket)
  }
  if (bucket.requests >= rule.maxRequests) {
    throw new AppError('Too many requests. Please try again later.', 'RATE_LIMITED')
  }
  bucket.requests++
}

/** Business handlers share one FIFO. Synchronous revocation never waits behind it. */
function serialize<T>(sender: WebContents, bytes: number, operation: () => Promise<T>): Promise<T> {
  let queue = queues.get(sender)
  if (!queue) {
    queue = { tail: Promise.resolve(), count: 0, bytes: 0 }
    queues.set(sender, queue)
  }
  if (
    queue.count >= MAX_QUEUE_LENGTH ||
    queue.bytes + bytes > MAX_QUEUE_BYTES ||
    queuedRequests >= MAX_GLOBAL_QUEUE_LENGTH ||
    queuedBytes + bytes > MAX_GLOBAL_QUEUE_BYTES
  ) {
    throw new AppError('Too many pending requests. Please try again later.', 'IPC_BUSY')
  }
  queue.count++
  queue.bytes += bytes
  queuedRequests++
  queuedBytes += bytes
  const current = queue
  const result = queue.tail.then(operation).finally(() => {
    current.count--
    current.bytes -= bytes
    queuedRequests--
    queuedBytes -= bytes
  })
  current.tail = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

// Never reflect caller-controlled unknown property names or custom error messages.
const safeErrorFields = new Set([
  'name',
  'email',
  'password',
  'notebookId',
  'diaryId',
  'diaryIds',
  'occurredAt',
  'markdown',
  'images',
  'reference',
  'mimeType',
  'dataUrl',
  'dataUrls',
  'itineraryId',
  'startTime',
  'places',
  'legs',
  'stayMinutes',
  'mode',
  'durationMinutes',
  'minImages',
  'imageId',
  'rounded',
  'action',
  'remember'
])
function boundedValidationErrors(error: z.ZodError): unknown {
  const issues = error.issues.slice(0, 16).map((issue) => ({
    // Flatten union/other nested issues instead of forwarding their untrusted trees.
    code: 'custom' as const,
    message: 'Invalid input.',
    path:
      issue.path.length <= 6 &&
      issue.path.every((part) =>
        typeof part === 'number'
          ? part >= 0 && part < 32
          : typeof part === 'string' && safeErrorFields.has(part)
      )
        ? issue.path
        : []
  }))
  return z.treeifyError(new z.ZodError(issues))
}

function failureResponse(error: unknown): IpcResponse<never> {
  if (error instanceof AppError) {
    return { success: false, message: error.message, code: error.code }
  }
  logger.error('[IPC] Operation failed.')
  return {
    success: false,
    message: 'An internal system error occurred. Please contact support.',
    code: 'INTERNAL_ERROR'
  }
}

/**
 * Only lock/logout may use this cheap, synchronous control path. It cannot be
 * starved by business rate/queue quotas, and its security-layer revocation
 * barrier invalidates both active work and requests already waiting in FIFO.
 * Keep schemas synchronous and payloads small; never put I/O or KDF work here.
 */
export function handleRevocation<T extends z.ZodType>(
  schema: T,
  revoke: (data: z.infer<T>, event: Electron.IpcMainInvokeEvent) => null
) {
  return (event: Electron.IpcMainInvokeEvent, args: unknown): IpcResponse<null> => {
    try {
      assertTrustedSender(event)
      payloadBytes(args, 4 * 1024)
      const validation = schema.safeParse(args)
      if (!validation.success) {
        return {
          success: false,
          message: 'Validation Failed',
          code: 'INVALID_INPUT',
          errors: boundedValidationErrors(validation.error)
        }
      }
      return { success: true, data: revoke(validation.data, event) }
    } catch (error) {
      return failureResponse(error)
    }
  }
}

export function handleWithValidation<T extends z.ZodType, R>(
  schema: T,
  handler: (data: z.infer<T>, event: Electron.IpcMainInvokeEvent) => Promise<R>,
  options: HandlerOptions = {}
) {
  return async (event: Electron.IpcMainInvokeEvent, args: unknown): Promise<IpcResponse<R>> => {
    try {
      const assertDocument = captureSender(event)
      // Capture at admission: queued requests must not inherit a later user's session.
      const assertSession = options.requireAuth ? captureSession(event).assertActive : undefined
      consumeRate(event.sender, { bucket: 'ipc:all', maxRequests: 120, windowMs: 60_000 })
      if (options.rateLimit) consumeRate(event.sender, options.rateLimit)
      const bytes = payloadBytes(args, options.maxPayloadBytes ?? 64 * 1024)
      return await serialize(event.sender, bytes, async () => {
        assertDocument()
        assertSession?.()
        const validation = await schema.safeParseAsync(args)
        assertDocument()
        assertSession?.()
        if (!validation.success) {
          return {
            success: false,
            message: 'Validation Failed',
            code: 'INVALID_INPUT',
            errors: boundedValidationErrors(validation.error)
          }
        }
        const result = await handler(validation.data, event)
        assertDocument()
        assertSession?.()
        return { success: true, data: result }
      })
    } catch (error) {
      return failureResponse(error)
    }
  }
}
