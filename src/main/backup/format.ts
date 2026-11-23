/**
 * Portable diary backup format: a JSON header, an encrypted manifest, and
 * per-diary / per-image ciphertext entries, bound together by SHA-256 and AAD.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  BACKUP_MAX_ENTRIES,
  BACKUP_MAX_ENTRY_BYTES,
  BACKUP_MAX_UNCOMPRESSED_BYTES
} from '@common/diary-limits'
import {
  NOTEBOOK_CRYPTO_VERSION,
  NOTEBOOK_KDF_ALGORITHM,
  NOTEBOOK_KDF_LIMITS,
  type EncryptedValue,
  type NotebookKeyEnvelope
} from '../crypto/notebook-crypto'

// Stable archive format identifiers and the two reserved top-level entry names.
export const DIARY_BACKUP_FORMAT = 'myapp-diary-backup'
export const DIARY_BACKUP_VERSION = 1
export const BACKUP_HEADER_ENTRY = 'header.json'
export const BACKUP_MANIFEST_ENTRY = 'manifest.enc'
export const BACKUP_MAX_HEADER_BYTES = 64 * 1024
export const BACKUP_MAX_MANIFEST_BYTES = 16 * 1024 * 1024

const base64 = z
  .string()
  .regex(/^[A-Za-z0-9+/]*={0,2}$/)
  .refine((value) => value.length % 4 === 0)
const uuid = z.uuid()
const fixedBase64 = (bytes: number): typeof base64 =>
  base64.length(Math.ceil(bytes / 3) * 4).refine((value) => {
    const decoded = Buffer.from(value, 'base64')
    try {
      return decoded.length === bytes && decoded.toString('base64') === value
    } finally {
      decoded.fill(0)
    }
  })

// Envelope metadata only; the ciphertext lives in a separate archive entry.
const EncryptedValueSchema = z
  .object({ ciphertext: base64, nonce: fixedBase64(12), tag: fixedBase64(16) })
  .strict()

/**
 * Archive header: the format's identity plus the wrapped-key envelope needed to
 * recover the data key. `manifest` holds only the nonce and tag of the
 * encrypted manifest, which is stored as a sibling entry.
 */
export const BackupHeaderSchema = z
  .object({
    format: z.literal(DIARY_BACKUP_FORMAT),
    version: z.literal(DIARY_BACKUP_VERSION),
    sourceNotebookUuid: uuid,
    sourceUserId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    cryptoVersion: z.literal(NOTEBOOK_CRYPTO_VERSION),
    kdfAlgorithm: z.literal(NOTEBOOK_KDF_ALGORITHM),
    kdfSalt: fixedBase64(16),
    kdfN: z
      .number()
      .int()
      .min(2)
      .max(NOTEBOOK_KDF_LIMITS.maxN)
      .refine((value) => (value & (value - 1)) === 0),
    kdfR: z.number().int().min(1).max(NOTEBOOK_KDF_LIMITS.maxR),
    kdfP: z.number().int().min(1).max(NOTEBOOK_KDF_LIMITS.maxP),
    wrappedKey: fixedBase64(32),
    wrappedKeyNonce: fixedBase64(12),
    wrappedKeyTag: fixedBase64(16),
    manifest: EncryptedValueSchema.omit({ ciphertext: true })
  })
  .strict()

export type BackupHeader = z.infer<typeof BackupHeaderSchema>
export const BackupUnsignedHeaderSchema = BackupHeaderSchema.omit({ manifest: true })

const BackupImageSchema = z
  .object({
    uuid,
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
    byteLength: z.number().int().positive().max(BACKUP_MAX_ENTRY_BYTES),
    path: z.string().regex(/^images\/[0-9a-f-]{36}\.enc$/i),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    encryption: EncryptedValueSchema.omit({ ciphertext: true })
  })
  .strict()

const BackupDiarySchema = z
  .object({
    uuid,
    occurredAt: z.string().datetime({ offset: true }),
    path: z.string().regex(/^diaries\/[0-9a-f-]{36}\.enc$/i),
    byteLength: z.number().int().nonnegative().max(BACKUP_MAX_ENTRY_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    encryption: EncryptedValueSchema.omit({ ciphertext: true }),
    images: z.array(BackupImageSchema).max(BACKUP_MAX_ENTRIES)
  })
  .strict()

/**
 * Encrypted manifest describing every diary and image entry: its archive path,
 * byte length, SHA-256, and encryption metadata. `superRefine` enforces path
 * uniqueness and aggregate limits before any entry is trusted or decrypted.
 */
export const BackupManifestSchema = z
  .object({
    format: z.literal(DIARY_BACKUP_FORMAT),
    version: z.literal(DIARY_BACKUP_VERSION),
    notebookName: z.string().min(1).max(80),
    exportedAt: z.string().datetime({ offset: true }),
    diaries: z.array(BackupDiarySchema).max(BACKUP_MAX_ENTRIES)
  })
  .strict()
  .superRefine((manifest, context) => {
    const paths = new Set<string>()
    // Reserve one slot for header.json and one for manifest.enc.
    let entries = 2
    let bytes = 0
    for (const diary of manifest.diaries) {
      entries++
      bytes += diary.byteLength
      if (paths.has(diary.path))
        context.addIssue({ code: 'custom', message: 'Duplicate backup path' })
      paths.add(diary.path)
      for (const image of diary.images) {
        entries++
        bytes += image.byteLength
        if (paths.has(image.path))
          context.addIssue({ code: 'custom', message: 'Duplicate backup path' })
        paths.add(image.path)
      }
    }
    if (entries > BACKUP_MAX_ENTRIES || bytes > BACKUP_MAX_UNCOMPRESSED_BYTES) {
      context.addIssue({ code: 'custom', message: 'Backup is too large' })
    }
  })

export type BackupManifest = z.infer<typeof BackupManifestSchema>

/** Extracts the wrapped-key envelope fields from a backup header. */
export function headerEnvelope(header: BackupHeader): NotebookKeyEnvelope {
  return {
    cryptoVersion: header.cryptoVersion,
    kdfAlgorithm: header.kdfAlgorithm,
    kdfSalt: header.kdfSalt,
    kdfN: header.kdfN,
    kdfR: header.kdfR,
    kdfP: header.kdfP,
    wrappedKey: header.wrappedKey,
    wrappedKeyNonce: header.wrappedKeyNonce,
    wrappedKeyTag: header.wrappedKeyTag
  }
}

/**
 * Serializes the header minus the manifest metadata, producing the exact bytes
 * hashed into the manifest AAD so both writer and reader agree on the bound header.
 */
export function canonicalHeaderWithoutManifest(header: Omit<BackupHeader, 'manifest'>): string {
  // Schema field order is the existing version-1 wire order, independent of
  // caller insertion order. Parsing also preserves strict version/KDF checks.
  return JSON.stringify(BackupUnsignedHeaderSchema.parse(header))
}

/** AAD hashing the header JSON so the manifest cannot be swapped between archives. */
export function backupManifestAad(headerJson: string): string {
  return `myapp:backup-manifest:v${DIARY_BACKUP_VERSION}:${sha256(Buffer.from(headerJson))}`
}

/**
 * AAD binding a backup diary ciphertext to the source notebook, UUID, and date,
 * so an entry cannot be replayed into a different backup.
 */
export function backupDiaryAad(
  sourceNotebookUuid: string,
  diaryUuid: string,
  occurredAt: string
): string {
  return `myapp:backup-diary:v${DIARY_BACKUP_VERSION}:${sourceNotebookUuid}:${diaryUuid}:${occurredAt}`
}

/** AAD binding a backup image ciphertext to its notebook, diary, UUID, and MIME type. */
export function backupImageAad(
  sourceNotebookUuid: string,
  diaryUuid: string,
  imageUuid: string,
  mimeType: string
): string {
  return `myapp:backup-image:v${DIARY_BACKUP_VERSION}:${sourceNotebookUuid}:${diaryUuid}:${imageUuid}:${mimeType}`
}

/** Hex-encoded SHA-256 digest used to verify entry integrity after extraction. */
export function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Strips the ciphertext, leaving only the nonce and tag for in-archive metadata. */
export function withoutCiphertext(value: EncryptedValue): Omit<EncryptedValue, 'ciphertext'> {
  return { nonce: value.nonce, tag: value.tag }
}
