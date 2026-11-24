import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const cliPath = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')

// Vite normalizes Windows drive letters to uppercase, while Node caches ESM by
// URL. Loading the CLI with a lowercase drive creates a second Vitest instance
// when tests import its uppercase URL, splitting the runner and suite state.
// Keep directory casing, UNC paths and non-Windows paths unchanged.
const canonicalCliPath =
  process.platform === 'win32'
    ? cliPath.replace(/^[a-z]:/, (drive) => drive.toUpperCase())
    : cliPath

// Preserve all CLI arguments and run in this process so watch-mode signals and
// test failure exit codes are handled by Vitest without a detached child.
process.argv[1] = canonicalCliPath
await import(pathToFileURL(canonicalCliPath).href)
