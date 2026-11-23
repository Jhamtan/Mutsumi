import { describe, expect, it } from 'vitest'
import { createIpcEvent } from '../helpers/ipc-event'
import {
  assertTrustedSender,
  setSession,
  clearSession,
  requireSession,
  beginAuthentication,
  captureSender,
  captureSession,
  captureNotebookOperation,
  withUnlockedNotebook,
  unlockNotebook,
  lockNotebook,
  requireUnlockedNotebook
} from '../../../src/main/ipc/security'

/**
 * Tests main-process IPC security: origin trust (including hash handling),
 * per-window sessions, and the in-memory notebook key lifecycle.
 */
describe('IPC sender trust', () => {
  it('accepts only the registered main frame and ignores hash routes', () => {
    const { event, sender } = createIpcEvent()
    expect(() => assertTrustedSender(event)).not.toThrow()
    // Hash routes don't change the page origin and must stay trusted.
    sender.mainFrame.url = 'file:///app/index.html#/home'
    expect(() => assertTrustedSender(event)).not.toThrow()
    expect(() =>
      assertTrustedSender({ ...event, senderFrame: createIpcEvent().event.senderFrame })
    ).toThrow(expect.objectContaining({ code: 'IPC_FORBIDDEN' }))
  })

  it.each([
    'file:///app/other.html',
    'file:///app/index.html?extra=true',
    'https://evil.example/',
    'not a URL'
  ])('rejects changed or malformed URLs: %s', (url) => {
    const { event, sender } = createIpcEvent()
    sender.mainFrame.url = url
    expect(() => assertTrustedSender(event)).toThrow(
      expect.objectContaining({ code: 'IPC_FORBIDDEN' })
    )
  })

  it.each([
    'http://localhost:5174/',
    'https://localhost:5173/',
    'http://127.0.0.1:5173/',
    'http://localhost:5173/other'
  ])('does not broaden development URL trust: %s', (url) => {
    const { event } = createIpcEvent(url, true, 'http://localhost:5173')
    expect(() => assertTrustedSender(event)).toThrow(
      expect.objectContaining({ code: 'IPC_FORBIDDEN' })
    )
  })

  it('accepts a development URL with a hash route', () => {
    const { event } = createIpcEvent('http://localhost:5173/#/login', true, 'http://localhost:5173')
    expect(() => assertTrustedSender(event)).not.toThrow()
  })

  it('fails closed for a malformed registered URL', () => {
    const { event } = createIpcEvent('file:///app/index.html', true, 'invalid')
    expect(() => assertTrustedSender(event)).toThrow(
      expect.objectContaining({ code: 'IPC_FORBIDDEN' })
    )
  })

  it('rejects unregistered, destroyed and already-destroyed senders', () => {
    const unregistered = createIpcEvent(undefined, false)
    expect(() => assertTrustedSender(unregistered.event)).toThrow(
      expect.objectContaining({ code: 'IPC_FORBIDDEN' })
    )
    const { event, sender } = createIpcEvent()
    sender.isDestroyed.mockReturnValue(true)
    expect(() => assertTrustedSender(event)).toThrow(
      expect.objectContaining({ code: 'IPC_FORBIDDEN' })
    )
    sender.isDestroyed.mockReturnValue(false)
    sender.emit('destroyed')
    expect(() => assertTrustedSender(event)).toThrow(
      expect.objectContaining({ code: 'IPC_FORBIDDEN' })
    )
  })
})

describe('IPC sessions', () => {
  it('scopes sessions per window and supports idempotent logout', () => {
    const first = createIpcEvent().event
    const second = createIpcEvent().event
    setSession(first, 42)
    expect(requireSession(first)).toBe(42)
    expect(() => requireSession(second)).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED' }))
    clearSession(first)
    clearSession(first)
    expect(() => requireSession(first)).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED' }))
  })

  it.each([
    [true, true],
    [false, false],
    [true, false]
  ])('preserves sessions on in-place or subframe navigation: %s, %s', (inPlace, isMainFrame) => {
    const { event, sender } = createIpcEvent()
    setSession(event, 42)
    sender.emit('did-start-navigation', {}, '', inPlace, isMainFrame)
    expect(requireSession(event)).toBe(42)
  })

  it('preserves current Electron same-document navigation including hash page switches', () => {
    const { event, sender } = createIpcEvent()
    setSession(event, 42)
    unlockNotebook(event, 7, Buffer.alloc(32, 7))
    const snapshot = captureSession(event)
    sender.mainFrame.url = 'file:///app/index.html#/photowall'
    sender.emit(
      'did-start-navigation',
      { isMainFrame: true, isSameDocument: true },
      '',
      false,
      true
    )
    expect(requireSession(event)).toBe(42)
    expect(snapshot.assertActive).not.toThrow()
    const key = requireUnlockedNotebook(event, 7)
    expect(key).toEqual(Buffer.alloc(32, 7))
    key.fill(0)
  })

  it('current Electron full-document flags revoke even if deprecated flags disagree', () => {
    const { event, sender } = createIpcEvent()
    setSession(event, 42)
    sender.emit(
      'did-start-navigation',
      { isMainFrame: true, isSameDocument: false },
      '',
      true,
      true
    )
    expect(() => requireSession(event)).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED' }))
  })

  it('current Electron subframe flags do not invalidate the main session', () => {
    const { event, sender } = createIpcEvent()
    setSession(event, 42)
    sender.emit(
      'did-start-navigation',
      { isMainFrame: false, isSameDocument: false },
      '',
      false,
      true
    )
    expect(requireSession(event)).toBe(42)
  })

  it('unknown navigation details fail closed', () => {
    const { event, sender } = createIpcEvent()
    setSession(event, 42)
    sender.emit('did-start-navigation', {})
    expect(() => requireSession(event)).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED' }))
  })

  it.each(['focus', 'blur', 'minimize', 'restore', 'hide', 'show'])(
    'does not log out the same window on %s',
    (eventName) => {
      const { event, sender } = createIpcEvent()
      setSession(event, 42)
      const snapshot = captureSession(event)
      sender.emit(eventName)
      expect(requireSession(event)).toBe(42)
      expect(snapshot.assertActive).not.toThrow()
    }
  )

  it('clears sessions when the main frame navigates', () => {
    const { event, sender } = createIpcEvent()
    setSession(event, 42)
    // A real (non-in-place) main-frame navigation invalidates the session.
    sender.emit('did-start-navigation', {}, '', false, true)
    expect(() => requireSession(event)).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED' }))
  })

  it('keeps notebook keys per window and clears them on lock, logout and navigation', () => {
    const first = createIpcEvent()
    const second = createIpcEvent()
    setSession(first.event, 42)
    setSession(second.event, 42)
    const key = Buffer.alloc(32, 7)
    unlockNotebook(first.event, 10, key)

    expect(requireUnlockedNotebook(first.event, 10)).toEqual(key)
    expect(() => requireUnlockedNotebook(second.event, 10)).toThrow(
      expect.objectContaining({ code: 'NOTEBOOK_LOCKED' })
    )
    lockNotebook(first.event, 10)
    expect(() => requireUnlockedNotebook(first.event, 10)).toThrow(
      expect.objectContaining({ code: 'NOTEBOOK_LOCKED' })
    )

    unlockNotebook(first.event, 10, key)
    clearSession(first.event)
    setSession(first.event, 42)
    expect(() => requireUnlockedNotebook(first.event, 10)).toThrow(
      expect.objectContaining({ code: 'NOTEBOOK_LOCKED' })
    )

    unlockNotebook(first.event, 10, key)
    first.sender.emit('did-start-navigation', {}, '', false, true)
    setSession(first.event, 42)
    expect(() => requireUnlockedNotebook(first.event, 10)).toThrow(
      expect.objectContaining({ code: 'NOTEBOOK_LOCKED' })
    )
  })

  it('validates unlock state and clears replaced keys when the session user changes', () => {
    const source = createIpcEvent()
    setSession(source.event, 42)
    expect(() => unlockNotebook(source.event, 0, Buffer.alloc(32))).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    )
    expect(() => unlockNotebook(source.event, 1, Buffer.alloc(31))).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    )

    const firstKey = Buffer.alloc(32, 1)
    const replacementKey = Buffer.alloc(32, 2)
    unlockNotebook(source.event, 1, firstKey)
    unlockNotebook(source.event, 1, replacementKey)
    expect(requireUnlockedNotebook(source.event, 1)).toEqual(replacementKey)
    setSession(source.event, 99)
    expect(() => requireUnlockedNotebook(source.event, 1)).toThrow(
      expect.objectContaining({ code: 'NOTEBOOK_LOCKED' })
    )
  })

  it('rejects session operations from an untrusted window', () => {
    const { event } = createIpcEvent(undefined, false)
    for (const operation of [
      () => setSession(event, 42),
      () => clearSession(event),
      () => requireSession(event)
    ]) {
      expect(operation).toThrow(expect.objectContaining({ code: 'IPC_FORBIDDEN' }))
    }
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid authenticated ids: %s',
    (id) => {
      const { event } = createIpcEvent()
      expect(() => setSession(event, id)).toThrow(
        expect.objectContaining({ code: 'INVALID_INPUT' })
      )
      expect(() => requireSession(event)).toThrow(
        expect.objectContaining({ code: 'AUTH_REQUIRED' })
      )
    }
  )

  it('invalidates an authentication attempt after logout or a newer attempt', () => {
    const { event } = createIpcEvent()
    const first = beginAuthentication(event)
    clearSession(event)
    expect(() => setSession(event, 42, first)).toThrow(
      expect.objectContaining({ code: 'OPERATION_CANCELLED' })
    )
    const second = beginAuthentication(event)
    const third = beginAuthentication(event)
    expect(() => setSession(event, 42, second)).toThrow()
    setSession(event, 42, third)
    expect(requireSession(event)).toBe(42)
  })

  it('invalidates a captured session even when the same user authenticates again', () => {
    const { event } = createIpcEvent()
    setSession(event, 42)
    const session = captureSession(event)
    setSession(event, 42)
    expect(() => session.assertActive()).toThrow(
      expect.objectContaining({ code: 'OPERATION_CANCELLED' })
    )
  })

  it('does not accept an old document after it navigates back to the same URL', () => {
    const { event, sender } = createIpcEvent()
    const guard = captureSender(event)
    sender.emit('did-start-navigation', {}, '', false, true)
    expect(() => guard()).toThrow(expect.objectContaining({ code: 'OPERATION_CANCELLED' }))
  })

  it('invalidates admission guards on explicit logout and lock, not successful authentication', () => {
    const { event } = createIpcEvent()
    const admitted = captureSender(event)
    const attempt = beginAuthentication(event)
    setSession(event, 42, attempt)
    expect(() => admitted()).not.toThrow()
    const beforeLock = captureSender(event)
    lockNotebook(event, 10)
    expect(() => beforeLock()).toThrow(expect.objectContaining({ code: 'OPERATION_CANCELLED' }))
    const beforeLogout = captureSender(event)
    clearSession(event)
    expect(() => beforeLogout()).toThrow(expect.objectContaining({ code: 'OPERATION_CANCELLED' }))
  })

  it('never zeroes an operation copy when locking or replacing the cached key', () => {
    const { event } = createIpcEvent()
    setSession(event, 42)
    const original = Buffer.alloc(32, 7)
    unlockNotebook(event, 10, original)
    const copy = requireUnlockedNotebook(event, 10)
    const secondCopy = requireUnlockedNotebook(event, 10)
    expect(copy).not.toBe(secondCopy)
    copy[0] = 8
    expect(secondCopy[0]).toBe(7)
    lockNotebook(event, 10)
    expect(copy[0]).toBe(8)
    expect(secondCopy).toEqual(original)
    copy.fill(0)
    secondCopy.fill(0)
  })

  it('rejects a delayed unlock after a lock that occurred before key recovery', () => {
    const { event } = createIpcEvent()
    setSession(event, 42)
    const { assertActive } = captureNotebookOperation(event, 10)
    lockNotebook(event, 10)
    expect(() => unlockNotebook(event, 10, Buffer.alloc(32, 7), assertActive)).toThrow(
      expect.objectContaining({ code: 'OPERATION_CANCELLED' })
    )
    expect(() => requireUnlockedNotebook(event, 10)).toThrow()
  })

  it.each(['success', 'failure', 'revoked'])(
    'scrubs the operation copy in finally: %s',
    async (mode) => {
      const { event } = createIpcEvent()
      setSession(event, 42)
      unlockNotebook(event, 10, Buffer.alloc(32, 7))
      let captured: Buffer | undefined
      const result = withUnlockedNotebook(event, 10, async (_user, key, guard) => {
        captured = key
        if (mode === 'revoked') lockNotebook(event, 10)
        expect(key[0]).toBe(7)
        guard()
        if (mode === 'failure') throw new Error('synthetic failure')
        return 5
      })
      if (mode === 'success') expect(await result).toBe(5)
      else await expect(result).rejects.toThrow()
      expect(captured).toEqual(Buffer.alloc(32))
    }
  )
})
