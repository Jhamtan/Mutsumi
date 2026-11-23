import { app, dialog } from 'electron'
import { initDatabase, sequelize } from './database/db'
import { setupLogger } from './logger'
import logger from './logger'

/**
 * Bootstraps runtime dependencies in order (logging, directories, database)
 * and owns graceful shutdown cleanup. IPC handler registration is wired in as
 * those subsystems are migrated.
 */

/**
 * Orchestrates application startup and shutdown, keeping a single process-wide
 * instance that owns the runtime lifecycle.
 */
export class AppInitializer {
  private static instance: AppInitializer | undefined

  private constructor() {
    // Instances are created only through getInstance().
  }

  /**
   * Returns the process-wide singleton, creating it lazily on first access.
   */
  public static getInstance(): AppInitializer {
    if (!AppInitializer.instance) {
      AppInitializer.instance = new AppInitializer()
    }

    return AppInitializer.instance
  }

  /**
   * Runs startup steps in dependency order. A failure shows a dialog and exits.
   */
  public async initialize(): Promise<void> {
    // Initialize logging
    setupLogger()

    try {
      // Prepare the base environment (e.g. create directories)
      logger.info('Initializing application...')
      this.setupDirectories()

      logger.info('Connecting to database...')
      await initDatabase()

      logger.info('✅ Application initialized successfully.')
    } catch (error) {
      this.handleInitError(error)
    }
  }

  /**
   * Performs shutdown teardown, primarily closing the SQLite connection so its
   * temporary files are released before the process exits.
   */
  public async cleanup(): Promise<void> {
    logger.info('🛑 Application is shutting down...')

    try {
      if (sequelize) {
        logger.info('Closing database connection...')
        await sequelize.close()
        logger.info('✅ Database connection closed.')
      }
    } catch (error) {
      logger.error('❌ Error during cleanup:', error)
      // No need to throw here: the app is exiting anyway, just log it
    } finally {
      logger.info('👋 Bye!')
    }
  }

  private setupDirectories(): void {
    // Reserved for creating application directories (e.g. the image cache).
  }

  private handleInitError(error: unknown): void {
    logger.error('❌ Fatal Error during initialization:', error)

    dialog.showErrorBox(
      'Application Startup Error',
      `Check logs for details.\n\nError: ${error instanceof Error ? error.message : String(error)}`
    )

    app.exit(1)
  }
}
