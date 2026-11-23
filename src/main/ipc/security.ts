/**
 * Tracks trusted renderer senders, authenticated sessions, and per-window
 * unlocked notebook keys, all scoped to a specific WebContents instance.
 */
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { AppError } from '../errors'

export type OperationGuard = () => void

type SenderState = {
  rendererUrl: string
  documentVersion: number
  revocationVersion: number
  sessionVersion: number
  notebookVersion: number
}

const trustedSenders = new Map<WebContents, SenderState>()
const sessions = new Map<WebContents, number>()
const unlockedNotebooks = new Map<WebContents, Map<number, Buffer>>()

function operationCancelled(): never {
  throw new AppError(
    'This operation is no longer authorized. Please try again.',
    'OPERATION_CANCELLED'
  )
}

function invalidateSession(sender: WebContents): void {
  const state = trustedSenders.get(sender)
  if (state) {
    state.sessionVersion++
    state.notebookVersion++
  }
  sessions.delete(sender)
  clearUnlockedNotebooks(sender)
}

function clearUnlockedNotebooks(sender: WebContents): void {
  const keys = unlockedNotebooks.get(sender)
  if (!keys) return
  // Scrub key material from memory before dropping the references.
  for (const key of keys.values()) key.fill(0)
  keys.clear()
  unlockedNotebooks.delete(sender)
}

/**
 * Registers a WebContents as a trusted IPC sender. The sender's session and
 * unlock state are cleared on main-frame navigation or window destruction.
 */
// Only windows created by the main process may register; login state is cleared on navigation or destruction
export function trustIpcSender(sender: WebContents, rendererUrl: string): void {
  const previous = trustedSenders.get(sender)
  if (previous) {
    invalidateSession(sender)
    previous.documentVersion++
    previous.rendererUrl = rendererUrl
    return
  }
  trustedSenders.set(sender, {
    rendererUrl,
    documentVersion: 0,
    revocationVersion: 0,
    sessionVersion: 0,
    notebookVersion: 0
  })
  sender.on('did-start-navigation', (details, _url, inPlace, isMainFrame) => {
    // Prefer current Electron event fields; the positional arguments are deprecated.
    // An unknown main-navigation shape is conservatively treated as a new document.
    const mainFrameNavigation =
      typeof details?.isMainFrame === 'boolean' ? details.isMainFrame : isMainFrame !== false
    const sameDocument =
      typeof details?.isSameDocument === 'boolean' ? details.isSameDocument : inPlace === true
    if (mainFrameNavigation && !sameDocument) {
      const state = trustedSenders.get(sender)
      if (state) state.documentVersion++
      invalidateSession(sender)
    }
  })
  sender.once('destroyed', () => {
    invalidateSession(sender)
    trustedSenders.delete(sender)
  })
}

/**
 * Throws IPC_FORBIDDEN unless the request comes from a trusted sender whose
 * main frame is at the registered URL.
 */
export function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const expected = trustedSenders.get(event.sender)
  if (!expected || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) {
    throw new AppError('Untrusted IPC sender.', 'IPC_FORBIDDEN')
  }
  try {
    const actual = new URL(event.senderFrame.url)
    const allowed = new URL(expected.rendererUrl)
    // The Vue router hash does not change the page origin; other same-origin pages or sub-frames are not allowed
    actual.hash = ''
    allowed.hash = ''
    if (actual.href !== allowed.href) throw new Error('Unexpected renderer URL')
  } catch {
    throw new AppError('Untrusted IPC sender.', 'IPC_FORBIDDEN')
  }
}

/** Captures document identity and explicit revocation barriers at IPC admission. */
export function captureSender(event: IpcMainInvokeEvent): OperationGuard {
  assertTrustedSender(event)
  const state = trustedSenders.get(event.sender)!
  const documentVersion = state.documentVersion
  const revocationVersion = state.revocationVersion
  return () => {
    assertTrustedSender(event)
    if (
      trustedSenders.get(event.sender) !== state ||
      state.documentVersion !== documentVersion ||
      state.revocationVersion !== revocationVersion
    ) {
      operationCancelled()
    }
  }
}

/** Starts a fresh authentication attempt, invalidating all previous attempts. */
export function beginAuthentication(event: IpcMainInvokeEvent): OperationGuard {
  assertTrustedSender(event)
  // A new attempt changes the session epoch, not the explicit revocation barrier.
  // Otherwise the attempt would invalidate its own admission guard.
  invalidateSession(event.sender)
  const assertDocument = captureSender(event)
  const state = trustedSenders.get(event.sender)!
  const sessionVersion = state.sessionVersion
  return () => {
    assertDocument()
    if (state.sessionVersion !== sessionVersion) operationCancelled()
  }
}

/** Only successful main-process authentication may establish a session. */
export function setSession(
  event: IpcMainInvokeEvent,
  userId: number,
  guard?: OperationGuard
): void {
  assertTrustedSender(event)
  guard?.()
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new AppError('Invalid session state.', 'INVALID_INPUT')
  }
  // Even re-authenticating the same account is a new authorization epoch.
  invalidateSession(event.sender)
  sessions.set(event.sender, userId)
}

/**
 * Ends the sender's session and wipes its unlocked notebook keys.
 */
export function clearSession(event: IpcMainInvokeEvent): void {
  assertTrustedSender(event)
  trustedSenders.get(event.sender)!.revocationVersion++
  invalidateSession(event.sender)
}

/**
 * Returns the authenticated user ID for the sender, throwing AUTH_REQUIRED
 * when no session exists. Callers must never accept a user ID from the renderer.
 */
// Protected endpoints (diary, etc.) must read the user ID from the main-process session, never trust a userId sent by the renderer
export function requireSession(event: IpcMainInvokeEvent): number {
  assertTrustedSender(event)
  const userId = sessions.get(event.sender)
  if (!userId) throw new AppError('Please log in first.', 'AUTH_REQUIRED')
  return userId
}

/** Captures user identity for awaits and the transaction's pre-commit decision. */
export function captureSession(event: IpcMainInvokeEvent): {
  userId: number
  assertActive: OperationGuard
} {
  const userId = requireSession(event)
  const assertDocument = captureSender(event)
  const state = trustedSenders.get(event.sender)!
  const sessionVersion = state.sessionVersion
  return {
    userId,
    assertActive: () => {
      assertDocument()
      if (state.sessionVersion !== sessionVersion || sessions.get(event.sender) !== userId) {
        operationCancelled()
      }
    }
  }
}

/**
 * Notebook revocations have a separate epoch. Conservatively, changing any
 * notebook key cancels outstanding notebook operations in the same window.
 * Explicit lock/logout also invalidate admission guards, so earlier queued
 * requests cannot start a fresh unlock/login after a revocation.
 */
export function captureNotebookOperation(
  event: IpcMainInvokeEvent,
  notebookId: number
): { userId: number; assertActive: OperationGuard } {
  if (!Number.isSafeInteger(notebookId) || notebookId <= 0) {
    throw new AppError('Invalid notebook unlock state.', 'INVALID_INPUT')
  }
  const session = captureSession(event)
  const state = trustedSenders.get(event.sender)!
  const notebookVersion = state.notebookVersion
  return {
    userId: session.userId,
    assertActive: () => {
      session.assertActive()
      if (state.notebookVersion !== notebookVersion) operationCancelled()
    }
  }
}

/** Stores a private cache copy; a late unlock may not replace revoked state. */
export function unlockNotebook(
  event: IpcMainInvokeEvent,
  notebookId: number,
  dataKey: Buffer,
  guard?: OperationGuard
): void {
  requireSession(event)
  guard?.()
  if (!Number.isSafeInteger(notebookId) || notebookId <= 0 || dataKey.length !== 32) {
    throw new AppError('Invalid notebook unlock state.', 'INVALID_INPUT')
  }
  let keys = unlockedNotebooks.get(event.sender)
  if (!keys) {
    keys = new Map()
    unlockedNotebooks.set(event.sender, keys)
  }
  keys.get(notebookId)?.fill(0)
  keys.set(notebookId, Buffer.from(dataKey))
  trustedSenders.get(event.sender)!.notebookVersion++
}

/**
 * Removes and zeroes the in-memory data key for a notebook.
 */
export function lockNotebook(event: IpcMainInvokeEvent, notebookId: number): void {
  requireSession(event)
  if (!Number.isSafeInteger(notebookId) || notebookId <= 0) {
    throw new AppError('Invalid notebook unlock state.', 'INVALID_INPUT')
  }
  const state = trustedSenders.get(event.sender)!
  state.revocationVersion++
  state.notebookVersion++
  const keys = unlockedNotebooks.get(event.sender)
  const key = keys?.get(notebookId)
  key?.fill(0)
  keys?.delete(notebookId)
  if (keys?.size === 0) unlockedNotebooks.delete(event.sender)
}

/**
 * Returns an operation-owned copy, never the mutable cached key. The caller
 * MUST clear this copy in finally, including failed and cancelled operations.
 */
export function requireUnlockedNotebook(event: IpcMainInvokeEvent, notebookId: number): Buffer {
  requireSession(event)
  const key = unlockedNotebooks.get(event.sender)?.get(notebookId)
  if (!key) throw new AppError('Unlock the notebook first.', 'NOTEBOOK_LOCKED')
  return Buffer.from(key)
}

/** Couples an independent key copy with revocation checks and guaranteed scrubbing. */
export async function withUnlockedNotebook<T>(
  event: IpcMainInvokeEvent,
  notebookId: number,
  operation: (userId: number, dataKey: Buffer, guard: OperationGuard) => Promise<T>
): Promise<T> {
  const { userId, assertActive } = captureNotebookOperation(event, notebookId)
  const dataKey = requireUnlockedNotebook(event, notebookId)
  try {
    assertActive()
    const result = await operation(userId, dataKey, assertActive)
    assertActive()
    return result
  } finally {
    dataKey.fill(0)
  }
}
