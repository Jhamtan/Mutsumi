import { is } from '@electron-toolkit/utils'
import { app } from 'electron'

/**
 * App-local filesystem path resolution.
 */

/**
 * Resolves app-local paths, returning the project cwd in development and the
 * userData directory in production.
 */
export class PathHelper {
  /**
   * Returns the base directory for app data such as logs and the database.
   */
  static getHomeDir(): string {
    if (is.dev) return process.cwd()
    else return app.getPath('userData')
  }
}
