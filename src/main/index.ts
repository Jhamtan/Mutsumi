import { app, shell, BrowserWindow, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'node:fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { AppInitializer } from './init'
import Store from 'electron-store'
import { WindowState } from './types'
import { pathToFileURL } from 'node:url'
import { trustIpcSender } from './ipc/security'
import { isAllowedRendererNavigation, getSafeExternalUrl } from './window/navigation-policy'
import { bindWindow, handleClose, showMainWindow, quitApplication } from './window/window-control'

/**
 * Electron main-process entry point: acquires the single-instance lock, configures
 * Chromium session storage, manages the main BrowserWindow lifecycle, and binds
 * application initialization/cleanup to Electron lifecycle events.
 */

// Acquire the lock before Chromium initializes caches or the database. If a prior
// development instance is still alive, the new process exits instead of becoming
// another hidden instance that competes for the same files.
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

/**
 * Keep Chromium caches in this app's own writable directory. Electron otherwise
 * derives a shared "Electron" cache path in development, where stale processes
 * can hold directory handles and produce Windows access-denied GPU cache errors.
 * This must run before `app.whenReady()` because Chromium creates caches early.
 */
function configureSessionStorage(): void {
  const sessionDataPath = join(app.getPath('userData'), 'Session Data')
  const cachePath = join(sessionDataPath, 'Cache')
  mkdirSync(cachePath, { recursive: true })
  app.setPath('sessionData', sessionDataPath)
  app.commandLine.appendSwitch('disk-cache-dir', cachePath)
}

if (hasSingleInstanceLock) configureSessionStorage()

// electron-store 12+ is a pure ESM package; the default export is the constructor, so no need to reach for .default
const store = hasSingleInstanceLock
  ? new Store<WindowState>({
      name: 'window-state', // file name: window-state.json
      defaults: {
        width: 900,
        height: 670
      }
    })
  : undefined

// System tray icon: left-click shows the main window, right-click opens the "Show window / Quit app" menu
let tray: Tray | null = null

function createWindow(): void {
  if (!store) return

  // Read the stored state
  const { width, height, x, y } = store.store
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: width,
    height: height,
    x: x,
    y: y,
    show: false,
    backgroundColor: '#f5f9f8',
    autoHideMenuBar: true,
    icon: icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  // Register only windows created by the main process, verifying the exact page URL and main frame
  const rendererUrl =
    is.dev && process.env['ELECTRON_RENDERER_URL']
      ? process.env['ELECTRON_RENDERER_URL']
      : pathToFileURL(join(__dirname, '../renderer/index.html')).href
  trustIpcSender(mainWindow.webContents, rendererUrl)

  // Register the main window so tray/close behavior can control its show/hide
  bindWindow(mainWindow)

  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  mainWindow.webContents.session.setPermissionCheckHandler(() => false)

  // Navigation and redirects must not expand the registered page's trust boundary; external links go to the external browser.
  mainWindow.webContents.on('will-navigate', (event) => {
    if (!isAllowedRendererNavigation(event.url, rendererUrl)) event.preventDefault()
  })
  mainWindow.webContents.on('will-frame-navigate', (event) => {
    if (!isAllowedRendererNavigation(event.url, rendererUrl)) event.preventDefault()
  })
  mainWindow.webContents.on('will-redirect', (event) => {
    if (!isAllowedRendererNavigation(event.url, rendererUrl)) event.preventDefault()
  })

  // Listen for the vue-app-ready signal from the renderer.
  // Bind to this window's own webContents so another window's ready signal cannot trigger it early in multi-window setups.
  mainWindow.webContents.ipc.once('vue-app-ready', () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  // Listen for window close to save state
  mainWindow.on('close', () => {
    // Window is not maximized
    if (!mainWindow.isMaximized()) {
      const bounds = mainWindow.getBounds()
      store.set({
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y
      })
    }
  })

  // When the title-bar "X" is clicked: hide to tray / quit per the persisted close behavior, or ask via the close dialog
  mainWindow.on('close', handleClose)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    const externalUrl = getSafeExternalUrl(details.url)
    if (externalUrl) {
      void shell.openExternal(externalUrl).catch(() => {
        console.warn('Unable to open external link')
      })
    }
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// The main process always reuses one initializer to manage the runtime lifecycle.
const initializer = AppInitializer.getInstance()

/**
 * Creates the system tray icon. Left-click reveals the main window; right-click
 * shows a context menu with "Show window" / "Quit app".
 */
function createTray(): void {
  if (!hasSingleInstanceLock || tray) return
  // The Windows tray needs a small icon; scale to 16×16 to avoid a large/blurry icon
  const trayImage = nativeImage.createFromPath(icon).resize({ width: 16, height: 16 })
  tray = new Tray(trayImage)
  tray.setToolTip('Mutsumi')
  // Left click: show and focus the main window
  tray.on('click', () => showMainWindow())
  // Right click (setContextMenu is triggered by right-click on Windows): show window / quit app
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示窗口', click: () => showMainWindow() },
      { type: 'separator' },
      { label: '退出应用', click: () => quitApplication() }
    ])
  )
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return

  app.on('second-instance', () => {
    const mainWindow = BrowserWindow.getAllWindows()[0]
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  await initializer.initialize()

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()
  createTray()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Electron fires before-quit more than once when cleanup eventually calls app.exit().
// Guard it so each quit runs cleanup exactly once and can then terminate.
let isQuitting = false
app.on('before-quit', async (event) => {
  if (isQuitting) return

  isQuitting = true
  event.preventDefault()

  try {
    await initializer.cleanup()
  } finally {
    app.exit(0)
  }
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
