/**
 * Size and count limits shared between the renderer (pre-flight checks) and the
 * main process (Zod validation and backup import guards).
 */

// Diary content: one markdown body plus its images.
export const DIARY_MARKDOWN_MAX_BYTES = 2 * 1024 * 1024 // 2 MB
export const DIARY_MAX_IMAGES = 40
export const DIARY_IMAGE_MAX_BYTES = 10 * 1024 * 1024 // 10 MB
// Per-diary aggregate image budget, lower than 40 × 10 MB to bound memory/disk use.
export const DIARY_IMAGES_MAX_BYTES = 100 * 1024 * 1024 // 100 MB

// Backup import guards: bound entry count, per-entry size, total uncompressed
// size and the compression ratio to prevent zip bombs.
export const BACKUP_MAX_ENTRIES = 2_000
export const BACKUP_MAX_ENTRY_BYTES = 64 * 1024 * 1024 // 64 MB
export const BACKUP_MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024 // 1 GB
export const BACKUP_MAX_COMPRESSION_RATIO = 200 // maximum compression ratio
