import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
// Resolve the exported package root first, then walk to its bundled CLI. This
// avoids importing a private package subpath blocked by Node's exports checks.
const packageEntry = require.resolve('electron-vite')
const cliPath = join(dirname(packageEntry), '../bin/electron-vite.js')

// VS Code's integrated terminal can inherit this from an Electron-based host.
// If it leaks into npm scripts, the Electron binary behaves like plain Node and
// `electron.app` is undefined, so electron-vite fails before creating a window.
delete process.env.ELECTRON_RUN_AS_NODE

// Run the CLI in this process so Ctrl+C reaches electron-vite directly and it
// can close its Electron child instead of leaving dev servers behind.
await import(pathToFileURL(cliPath).href)
