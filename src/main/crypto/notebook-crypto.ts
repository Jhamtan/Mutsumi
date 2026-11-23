/**
 * Notebook cryptography: scrypt-based key wrapping plus AES-256-GCM AEAD for
 * diary content and images, binding every ciphertext to its owner via AAD.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual
} from 'node:crypto'
import { AppError } from '../errors'

/**
 * Promisified scrypt KDF producing a 32-byte key. The caller supplies bounded
 * work-factor parameters read from the stored envelope.
 */
function deriveScrypt(
  password: string,
  salt: Buffer,
  options: { N: number; r: number; p: number; maxmem: number }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, KEY_BYTES, options, (error, derivedKey) => {
      if (error) reject(error)
      else resolve(derivedKey as Buffer)
    })
  })
}

export const NOTEBOOK_CRYPTO_VERSION = 1
export const NOTEBOOK_KDF_ALGORITHM = 'scrypt' as const
export const NOTEBOOK_KDF_DEFAULTS = Object.freeze({ n: 16_384, r: 8, p: 1 })
export const NOTEBOOK_KDF_LIMITS = Object.freeze({ maxN: 65_536, maxR: 16, maxP: 4 })
// AES-256 key size, GCM's recommended 96-bit nonce, and its 128-bit auth tag.
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16
const SALT_BYTES = 16

/** Persisted wrapped-key envelope: scrypt parameters plus the GCM-wrapped data key. */
export interface NotebookKeyEnvelope {
  cryptoVersion: number
  kdfAlgorithm: typeof NOTEBOOK_KDF_ALGORITHM
  kdfSalt: string
  kdfN: number
  kdfR: number
  kdfP: number
  wrappedKey: string
  wrappedKeyNonce: string
  wrappedKeyTag: string
}

/** An AES-256-GCM output: base64 ciphertext, nonce, and authentication tag. */
export interface EncryptedValue {
  ciphertext: string
  nonce: string
  tag: string
}

/**
 * Strict base64 decoder enforcing canonical encoding and an optional exact byte
 * length, so malformed envelope fields fail before any crypto operation runs.
 */
function decodeBase64(value: string, expectedBytes?: number): Buffer {
  if (
    typeof value !== 'string' ||
    value.length % 4 !== 0 ||
    (expectedBytes !== undefined && value.length !== Math.ceil(expectedBytes / 3) * 4)
  ) {
    throw new Error('Invalid base64')
  }
  // A quantified group can exhaust V8's regexp stack on legitimate MiB-sized
  // ciphertext. Scan once, then round-trip to reject noncanonical padding bits.
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  for (let index = 0; index < value.length - padding; index++) {
    const code = value.charCodeAt(index)
    if (!(
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47
    )) {
      throw new Error('Invalid base64')
    }
  }
  const decoded = Buffer.from(value, 'base64')
  if (
    decoded.toString('base64') !== value ||
    (expectedBytes !== undefined && decoded.length !== expectedBytes)
  ) {
    decoded.fill(0)
    throw new Error('Invalid base64 length')
  }
  return decoded
}

/** Rejects envelopes whose scrypt parameters could exhaust memory or CPU. */
function validateEnvelope(envelope: NotebookKeyEnvelope): void {
  if (
    envelope.cryptoVersion !== NOTEBOOK_CRYPTO_VERSION ||
    envelope.kdfAlgorithm !== NOTEBOOK_KDF_ALGORITHM ||
    !Number.isInteger(envelope.kdfN) ||
    envelope.kdfN < 2 ||
    (envelope.kdfN & (envelope.kdfN - 1)) !== 0 ||
    envelope.kdfN > NOTEBOOK_KDF_LIMITS.maxN ||
    !Number.isInteger(envelope.kdfR) ||
    envelope.kdfR < 1 ||
    envelope.kdfR > NOTEBOOK_KDF_LIMITS.maxR ||
    !Number.isInteger(envelope.kdfP) ||
    envelope.kdfP < 1 ||
    envelope.kdfP > NOTEBOOK_KDF_LIMITS.maxP
  ) {
    throw new Error('Unsupported key envelope')
  }
}

/**
 * Derives the KEK from the password using the envelope's scrypt parameters.
 * `maxmem` scales with N*r to bound memory to the stored, validated parameters.
 */
async function deriveKey(
  password: string,
  envelope: Pick<NotebookKeyEnvelope, 'kdfSalt' | 'kdfN' | 'kdfR' | 'kdfP'>
): Promise<Buffer> {
  const salt = decodeBase64(envelope.kdfSalt, SALT_BYTES)
  try {
    return await deriveScrypt(password, salt, {
      N: envelope.kdfN,
      r: envelope.kdfR,
      p: envelope.kdfP,
      maxmem: Math.max(32 * 1024 * 1024, 128 * envelope.kdfN * envelope.kdfR + 1024 * 1024)
    })
  } finally {
    salt.fill(0)
  }
}

// Binds the wrapped key to its notebook so a valid envelope cannot be replayed
// against a different notebook (the GCM tag then fails to verify).
function wrappingAad(notebookUuid: string): Buffer {
  return Buffer.from(`myapp:notebook-key:v${NOTEBOOK_CRYPTO_VERSION}:${notebookUuid}`, 'utf8')
}

/** Generates a fresh 256-bit random data key for encrypting a notebook's contents. */
export function createDataKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

/**
 * Wraps the plaintext data key under a scrypt-derived KEK using AES-256-GCM.
 * The notebook UUID is bound into the AAD and key material is zeroed afterwards.
 */
export async function wrapDataKey(
  password: string,
  notebookUuid: string,
  dataKey: Buffer
): Promise<NotebookKeyEnvelope> {
  if (dataKey.length !== KEY_BYTES) throw new Error('Invalid data key')
  const salt = randomBytes(SALT_BYTES)
  const base = {
    cryptoVersion: NOTEBOOK_CRYPTO_VERSION,
    kdfAlgorithm: NOTEBOOK_KDF_ALGORITHM,
    kdfSalt: salt.toString('base64'),
    kdfN: NOTEBOOK_KDF_DEFAULTS.n,
    kdfR: NOTEBOOK_KDF_DEFAULTS.r,
    kdfP: NOTEBOOK_KDF_DEFAULTS.p
  }
  salt.fill(0)
  const key = await deriveKey(password, base)
  const nonce = randomBytes(NONCE_BYTES)
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(wrappingAad(notebookUuid))
    const wrapped = Buffer.concat([cipher.update(dataKey), cipher.final()])
    return {
      ...base,
      wrappedKey: wrapped.toString('base64'),
      wrappedKeyNonce: nonce.toString('base64'),
      wrappedKeyTag: cipher.getAuthTag().toString('base64')
    }
  } finally {
    key.fill(0)
    nonce.fill(0)
  }
}

/**
 * Reverses {@link wrapDataKey}: derives the KEK, authenticates the envelope, and
 * returns the recovered data key. Any failure maps to a uniform
 * INVALID_NOTEBOOK_PASSWORD error to avoid revealing whether the password or
 * the stored data was wrong. All intermediate key material is zeroed.
 */
export async function unwrapDataKey(
  password: string,
  notebookUuid: string,
  envelope: NotebookKeyEnvelope
): Promise<Buffer> {
  let key: Buffer | undefined
  let nonce: Buffer | undefined
  let tag: Buffer | undefined
  let wrapped: Buffer | undefined
  let pending: Buffer | undefined
  let final: Buffer | undefined
  let dataKey: Buffer | undefined
  try {
    validateEnvelope(envelope)
    key = await deriveKey(password, envelope)
    nonce = decodeBase64(envelope.wrappedKeyNonce, NONCE_BYTES)
    tag = decodeBase64(envelope.wrappedKeyTag, TAG_BYTES)
    wrapped = decodeBase64(envelope.wrappedKey, KEY_BYTES)
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(wrappingAad(notebookUuid))
    decipher.setAuthTag(tag)
    pending = decipher.update(wrapped)
    final = decipher.final()
    dataKey = Buffer.concat([pending, final])
    if (dataKey.length !== KEY_BYTES) throw new Error('Invalid data key')
    return dataKey
  } catch {
    dataKey?.fill(0)
    throw new AppError('Invalid notebook password or damaged data.', 'INVALID_NOTEBOOK_PASSWORD')
  } finally {
    // GCM update() can expose a candidate key before final() authenticates it.
    pending?.fill(0)
    final?.fill(0)
    key?.fill(0)
    nonce?.fill(0)
    tag?.fill(0)
    wrapped?.fill(0)
  }
}

/**
 * Encrypts raw bytes with AES-256-GCM. The caller-supplied AAD is authenticated
 * (but not encrypted) so any tampering with the associated context is detected.
 */
export function encryptBytes(data: Uint8Array, dataKey: Buffer, aad: string): EncryptedValue {
  if (dataKey.length !== KEY_BYTES) throw new Error('Invalid data key')
  const nonce = randomBytes(NONCE_BYTES)
  try {
    const cipher = createCipheriv('aes-256-gcm', dataKey, nonce)
    cipher.setAAD(Buffer.from(aad, 'utf8'))
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()])
    return {
      ciphertext: ciphertext.toString('base64'),
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64')
    }
  } finally {
    nonce.fill(0)
  }
}

/**
 * Decrypts AES-256-GCM ciphertext, authenticating the same AAD used at
 * encryption time; a mismatched AAD or tampered ciphertext fails verification.
 */
export function decryptBytes(value: EncryptedValue, dataKey: Buffer, aad: string): Buffer {
  let nonce: Buffer | undefined
  let tag: Buffer | undefined
  let ciphertext: Buffer | undefined
  let pending: Buffer | undefined
  let final: Buffer | undefined
  let plaintext: Buffer | undefined
  try {
    nonce = decodeBase64(value.nonce, NONCE_BYTES)
    tag = decodeBase64(value.tag, TAG_BYTES)
    ciphertext = decodeBase64(value.ciphertext)
    const decipher = createDecipheriv('aes-256-gcm', dataKey, nonce)
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(tag)
    pending = decipher.update(ciphertext)
    final = decipher.final()
    plaintext = Buffer.concat([pending, final])
    return plaintext
  } catch {
    plaintext?.fill(0)
    throw new AppError('Encrypted diary data is damaged.', 'DIARY_DATA_DAMAGED')
  } finally {
    // update() can return unauthenticated plaintext before final() throws.
    pending?.fill(0)
    final?.fill(0)
    nonce?.fill(0)
    tag?.fill(0)
    ciphertext?.fill(0)
  }
}

/** UTF-8 encodes and encrypts text, zeroing the plaintext buffer afterwards. */
export function encryptText(value: string, dataKey: Buffer, aad: string): EncryptedValue {
  const plaintext = Buffer.from(value, 'utf8')
  try {
    return encryptBytes(plaintext, dataKey, aad)
  } finally {
    plaintext.fill(0)
  }
}

/** Decrypts text and UTF-8 decodes it, zeroing the decrypted buffer afterwards. */
export function decryptText(value: EncryptedValue, dataKey: Buffer, aad: string): string {
  const plaintext = decryptBytes(value, dataKey, aad)
  try {
    return plaintext.toString('utf8')
  } finally {
    plaintext.fill(0)
  }
}

/**
 * AAD binding a diary's ciphertext to its notebook, UUID, and occurred-at
 * timestamp, so a ciphertext cannot be moved to another diary or re-dated.
 */
export function diaryContentAad(
  notebookUuid: string,
  diaryUuid: string,
  occurredAt: string
): string {
  return `myapp:diary:v${NOTEBOOK_CRYPTO_VERSION}:${notebookUuid}:${diaryUuid}:${occurredAt}`
}

/** AAD binding an image ciphertext to its notebook, diary, UUID, and MIME type. */
export function diaryImageAad(
  notebookUuid: string,
  diaryUuid: string,
  imageUuid: string,
  mimeType: string
): string {
  return `myapp:diary-image:v${NOTEBOOK_CRYPTO_VERSION}:${notebookUuid}:${diaryUuid}:${imageUuid}:${mimeType}`
}

/** Constant-time string comparison to avoid timing side-channels on secrets. */
export function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}
