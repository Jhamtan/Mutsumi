import { defineConfig } from 'vitest/config'
import base from './vitest.config.mts'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const testTemporaryRoot = fileURLToPath(new URL('./outputs/security-test-tmp/', import.meta.url))
mkdirSync(testTemporaryRoot, { recursive: true })
process.env.TEMP = testTemporaryRoot
process.env.TMP = testTemporaryRoot
process.env.TMPDIR = testTemporaryRoot

// Include all unit tests after the user restored access to the security tests.
// Keep temporary transforms isolated from node_modules/.vitest-cache.
export default defineConfig({
  ...base,
  cacheDir: 'outputs/security-test-tmp/vite-cache',
  test: {
    ...base.test,
    fsModuleCache: false,
    maxWorkers: 1,
    fileParallelism: false,
    pool: 'vmForks',
    projects: [
      {
        extends: true,
        test: {
          name: 'main',
          environment: 'node',
          fsModuleCache: false,
          include: ['tests/unit/common/**/*.test.ts', 'tests/unit/main/**/*.test.ts']
        }
      },
      {
        extends: true,
        test: {
          name: 'renderer',
          environment: 'jsdom',
          fsModuleCache: false,
          include: ['tests/unit/renderer/**/*.test.ts'],
          setupFiles: ['tests/unit/setup/renderer.ts']
        }
      }
    ]
  }
})
