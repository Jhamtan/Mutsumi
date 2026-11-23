import { realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { AppError } from '../errors'

const activeDestinations = new Set<string>()

/** Avoid two app windows replacing or rolling back the same export destination. */
export async function withExportDestination<T>(
  outputPath: string,
  operation: () => Promise<T>,
  guard?: () => void
): Promise<T> {
  guard?.()
  const parent = await realpath(dirname(outputPath))
  guard?.()
  const canonicalPath = join(parent, basename(outputPath))
  const identity = process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath
  if (activeDestinations.has(identity)) {
    throw new AppError('An export to this destination is already in progress.', 'IPC_BUSY')
  }
  activeDestinations.add(identity)
  try {
    guard?.()
    return await operation()
  } finally {
    activeDestinations.delete(identity)
  }
}
