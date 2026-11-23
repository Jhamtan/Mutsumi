import { app, dialog } from 'electron'
import { setupLogger } from './logger'
import logger from './logger'

/**
 * Bootstraps runtime dependencies in order (logging, directories) and owns
 * graceful shutdown cleanup. Database connection and IPC handler registration
 * are wired in as those subsystems are migrated.
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

      logger.info('✅ Application initialized successfully.')
    } catch (error) {
      this.handleInitError(error)
    }
  }

  /**
   * Performs shutdown teardown. Database connection closure is added when
   * persistence is migrated; the app is exiting regardless, so failures only log.
   */
  public async cleanup(): Promise<void> {
    logger.info('🛑 Application is shutting down...')
    // Database connection teardown is wired in once persistence is migrated.
    logger.info('👋 Bye!')
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
