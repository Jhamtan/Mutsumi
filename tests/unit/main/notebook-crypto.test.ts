import { afterEach, describe, expect, it, vi } from 'vitest'
import { Decipheriv } from 'node:crypto'
import {
  createDataKey,
  decryptBytes,
  decryptText,
  diaryContentAad,
  encryptBytes,
  encryptText,
  unwrapDataKey,
  wrapDataKey
} from '../../../src/main/crypto/notebook-crypto'

/**
 * Tests notebook encryption primitives: password-based key wrapping,
 * tamper/wrong-password rejection, and authenticated content encryption.
 */
const password = 'portable-notebook-password'
const notebookUuid = '6cedcdb2-b463-4bf1-af9b-a5c62a4fa98d'
// Tracked so sensitive key buffers can be zeroed after each test.
const keys: Buffer[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const key of keys) key.fill(0)
  keys.length = 0
})

describe('notebook crypto', () => {
  it('wraps a random data key with a portable password-derived key', async () => {
    const dataKey = createDataKey()
    keys.push(dataKey)
    const envelope = await wrapDataKey(password, notebookUuid, dataKey)
    const unwrapped = await unwrapDataKey(password, notebookUuid, envelope)
    keys.push(unwrapped)

    expect(unwrapped).toEqual(dataKey)
    expect(JSON.stringify(envelope)).not.toContain(password)
    expect(JSON.stringify(envelope)).not.toContain(dataKey.toString('hex'))
  })

  it('rejects a wrong password and tampered key envelope uniformly', async () => {
    const dataKey = createDataKey()
    keys.push(dataKey)
    const envelope = await wrapDataKey(password, notebookUuid, dataKey)

    for (const candidate of [
      () => unwrapDataKey('wrong-password', notebookUuid, envelope),
      () =>
        unwrapDataKey(password, notebookUuid, {
          ...envelope,
          wrappedKeyTag: Buffer.alloc(16).toString('base64')
        }),
      // A different KDF cost derives a different key, so unwrap must also fail.
      () => unwrapDataKey(password, notebookUuid, { ...envelope, kdfN: 1_048_576 })
    ]) {
      await expect(candidate()).rejects.toMatchObject({ code: 'INVALID_NOTEBOOK_PASSWORD' })
    }
  })

  it.each(['wrong-password', 'tampered-tag', 'wrong-aad'] as const)(
    'clears candidate key bytes when GCM authentication rejects %s',
    async (mode) => {
      const dataKey = createDataKey()
      keys.push(dataKey)
      const envelope = await wrapDataKey(password, notebookUuid, dataKey)
      const tag = Buffer.from(envelope.wrappedKeyTag, 'base64')
      tag[0] ^= 1
      const candidate =
        mode === 'tampered-tag' ? { ...envelope, wrappedKeyTag: tag.toString('base64') } : envelope
      tag.fill(0)
      const update = vi.spyOn(Decipheriv.prototype, 'update')
      const final = vi.spyOn(Decipheriv.prototype, 'final')

      await expect(
        unwrapDataKey(
          mode === 'wrong-password' ? 'wrong-password' : password,
          mode === 'wrong-aad' ? 'other-notebook' : notebookUuid,
          candidate
        )
      ).rejects.toMatchObject({ code: 'INVALID_NOTEBOOK_PASSWORD' })

      expect(update).toHaveBeenCalledTimes(1)
      const pending = update.mock.results[0].value
      expect(Buffer.isBuffer(pending)).toBe(true)
      expect((pending as Buffer).length).toBe(32)
      expect((pending as Buffer).every((byte) => byte === 0)).toBe(true)
      expect(final.mock.results[0].type).toBe('throw')
      expect(dataKey.some((byte) => byte !== 0)).toBe(true)
    }
  )

  it('clears intermediate key buffers without erasing the successful recovered key', async () => {
    const dataKey = createDataKey()
    keys.push(dataKey)
    const envelope = await wrapDataKey(password, notebookUuid, dataKey)
    const update = vi.spyOn(Decipheriv.prototype, 'update')
    const final = vi.spyOn(Decipheriv.prototype, 'final')

    const unwrapped = await unwrapDataKey(password, notebookUuid, envelope)
    keys.push(unwrapped)
    expect(unwrapped.equals(dataKey)).toBe(true)
    const pending = update.mock.results[0].value as Buffer
    const completed = final.mock.results[0].value as Buffer
    expect(pending.every((byte) => byte === 0)).toBe(true)
    expect(completed.every((byte) => byte === 0)).toBe(true)
    expect(unwrapped).not.toBe(pending)
    expect(unwrapped).not.toBe(completed)
  })

  it('clears an invalid-length recovered key and both intermediate buffers', async () => {
    const dataKey = createDataKey()
    keys.push(dataKey)
    const envelope = await wrapDataKey(password, notebookUuid, dataKey)
    const completed = Buffer.from([0x55])
    const update = vi.spyOn(Decipheriv.prototype, 'update')
    // Narrow to the zero-argument Buffer overload exercised by unwrapDataKey.
    const bufferFinal: { final(): Buffer } = Decipheriv.prototype
    vi.spyOn(bufferFinal, 'final').mockReturnValue(completed)
    const concat = vi.spyOn(Buffer, 'concat')

    await expect(unwrapDataKey(password, notebookUuid, envelope)).rejects.toMatchObject({
      code: 'INVALID_NOTEBOOK_PASSWORD'
    })

    const pending = update.mock.results[0].value as Buffer
    expect(pending.every((byte) => byte === 0)).toBe(true)
    expect(completed.every((byte) => byte === 0)).toBe(true)
    const rejectedOutputs = concat.mock.results
      .filter(
        (result) =>
          result.type === 'return' && Buffer.isBuffer(result.value) && result.value.length === 33
      )
      .map((result) => result.value as Buffer)
    expect(rejectedOutputs).toHaveLength(1)
    expect(rejectedOutputs[0].every((byte) => byte === 0)).toBe(true)
  })

  it.each([2 * 1024 * 1024, 10 * 1024 * 1024])(
    'round-trips legitimate large ciphertext without a regexp stack failure: %i bytes',
    (size) => {
      const dataKey = createDataKey()
      keys.push(dataKey)
      const input = Buffer.alloc(size, 0x5a)
      let output: Buffer | undefined
      try {
        const encrypted = encryptBytes(input, dataKey, 'synthetic-large-ciphertext')
        output = decryptBytes(encrypted, dataKey, 'synthetic-large-ciphertext')
        expect(output.equals(input)).toBe(true)
        expect(() =>
          decryptBytes(
            { ...encrypted, ciphertext: `${encrypted.ciphertext.slice(0, -4)}!!!!` },
            dataKey,
            'synthetic-large-ciphertext'
          )
        ).toThrow(expect.objectContaining({ code: 'DIARY_DATA_DAMAGED' }))
      } finally {
        input.fill(0)
        output?.fill(0)
      }
    }
  )

  it('continues rejecting noncanonical base64 and supports empty GCM ciphertext', () => {
    const dataKey = createDataKey()
    keys.push(dataKey)
    const encrypted = encryptBytes(Buffer.alloc(0), dataKey, 'empty')
    const empty = decryptBytes(encrypted, dataKey, 'empty')
    expect(empty.length).toBe(0)
    for (const ciphertext of ['YQ', 'YR==', 'YQ=!', 'YQ==\n', '====']) {
      expect(() => decryptBytes({ ...encrypted, ciphertext }, dataKey, 'empty')).toThrow(
        expect.objectContaining({ code: 'DIARY_DATA_DAMAGED' })
      )
    }
  })

  it('authenticates ciphertext and record identity with fresh nonces', () => {
    const dataKey = createDataKey()
    keys.push(dataKey)
    // AAD binds each ciphertext to its notebook, diary and timestamp to prevent replay.
    const aad = diaryContentAad(
      notebookUuid,
      '1a2fdb1f-2a5a-49fd-8851-f525e9f7aa40',
      '2026-10-28T12:00:00.000Z'
    )
    const first = encryptText('private diary', dataKey, aad)
    const second = encryptText('private diary', dataKey, aad)

    expect(first.ciphertext).not.toBe('private diary')
    // Identical plaintext still yields a fresh nonce, so ciphertexts differ.
    expect(first.nonce).not.toBe(second.nonce)
    expect(decryptText(first, dataKey, aad)).toBe('private diary')
    expect(() => decryptText(first, dataKey, `${aad}:other`)).toThrow(
      expect.objectContaining({ code: 'DIARY_DATA_DAMAGED' })
    )
  })
})
