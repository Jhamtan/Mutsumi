import log from 'electron-log/main'
import { PathHelper } from './libs/path'

/**
 * Configures electron-log for the main process: file/console transports, log
 * rotation limits, and global uncaught error hooks.
 */

/** Initializes logging transports and registers process-level error handlers. */
export function setupLogger(): void {
  log.initialize()

  // 1. Set the log file path (optional; defaults to userData/logs)
  log.transports.file.resolvePathFn = () => `${PathHelper.getHomeDir()}/logs/main.log`

  // 2. Configure console output
  log.transports.console.format = '{h}:{i}:{s} {text}'
  const isDevelopment = process.env.NODE_ENV === 'development'
  if (isDevelopment) {
    log.transports.console.level = 'debug'
  } else {
    log.transports.console.level = false // disable console output
  }

  // 3. Configure file output
  log.transports.file.level = 'info' // the file logs info level and above only
  log.transports.file.maxSize = 10 * 1024 * 1024 // max 10 MB
  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'

  // 4. Capture unhandled errors (very important!)
  process.on('uncaughtException', (error) => {
    log.error('🔥 Uncaught Exception:', error)
  })

  process.on('unhandledRejection', (reason, promise) => {
    log.error('🔥 Unhandled Rejection:', reason, promise)
  })

  // Take over console.log (optional; existing console.log calls would also be written to file)
  // Object.assign(console, log.functions);

  log.info('🚀 Logger initialized. Application starting...')
}

export default log
