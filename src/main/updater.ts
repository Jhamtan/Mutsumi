/**
 * Auto-update service: wraps electron-updater to check for and install updates
 * published to GitHub Releases. Persists the "auto check on launch" preference
 * (enabled by default) and broadcasts update status changes to the renderer.
 */
import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import Store from 'electron-store'
import type { UpdateInfoDTO, UpdateSettingsDTO, UpdateStatusDTO } from '../common/types'
import logger from './logger'

/** Public repository used by the About card and as the update feed. */
const REPO_URL = 'https://github.com/Jhamtan/Mutsumi'
const APP_NAME = 'Mutsumi'
/** Delay the launch auto-check so the window has time to render. */
const AUTO_CHECK_DELAY_MS = 5_000

interface UpdateSettings {
  autoCheck: boolean
}

let store: Store<UpdateSettings> | undefined
let status: UpdateStatusDTO = { state: 'idle' }

function getStore(): Store<UpdateSettings> {
  store ??= new Store<UpdateSettings>({
    name: 'update-settings',
    defaults: { autoCheck: true }
  })
  return store
}

/** Broadcasts an update message to every open window. */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function setStatus(next: UpdateStatusDTO): void {
  status = next
  broadcast('update:status', status)
}

/** Configures electron-updater and wires its events to the shared status. */
export function initUpdater(): void {
  autoUpdater.logger = logger
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    setStatus({ state: 'available', version: info.version })
  )
  autoUpdater.on('update-not-available', (info) =>
    setStatus({ state: 'not-available', version: info.version })
  )
  autoUpdater.on('download-progress', (progress) =>
    setStatus({ ...status, state: 'downloading', percent: Math.round(progress.percent) })
  )
  autoUpdater.on('update-downloaded', (info) =>
    setStatus({ state: 'downloaded', version: info.version })
  )
  autoUpdater.on('error', (error) => {
    logger.error('[Updater]', error)
    setStatus({ state: 'error', message: error.message })
  })

  // Auto-check on launch only for packaged builds and only when enabled.
  if (app.isPackaged && getStore().get('autoCheck')) {
    setTimeout(() => void checkForUpdates(), AUTO_CHECK_DELAY_MS)
  }
}

/** Triggers a check; the result is delivered through the status broadcast. */
export function checkForUpdates(): UpdateStatusDTO {
  if (!app.isPackaged) {
    setStatus({ state: 'error', message: 'Auto-update is only available in a packaged build.' })
    return status
  }
  autoUpdater.checkForUpdates().catch((error) => {
    logger.error('[Updater] check failed', error)
  })
  return status
}

/** Installs a downloaded update, quitting and restarting the app. */
export function installUpdate(): void {
  autoUpdater.quitAndInstall()
}

/** Returns the persisted auto-check preference (defaults to enabled). */
export function getAutoCheck(): boolean {
  return getStore().get('autoCheck')
}

/** Persists the auto-check preference. */
export function setAutoCheck(enabled: boolean): void {
  getStore().set('autoCheck', enabled)
}

/** Static metadata shown in the About card. */
export function getAppInfo(): UpdateInfoDTO {
  return {
    name: APP_NAME,
    version: app.getVersion(),
    repoUrl: REPO_URL,
    isPackaged: app.isPackaged
  }
}

/** Current update status, used to seed the About card on first render. */
export function getUpdateStatus(): UpdateStatusDTO {
  return status
}

export type { UpdateSettingsDTO }
