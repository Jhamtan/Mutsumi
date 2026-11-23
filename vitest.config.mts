import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@common': fileURLToPath(new URL('./src/common', import.meta.url)),
      '@renderer': fileURLToPath(new URL('./src/renderer/src', import.meta.url))
    }
  },
  test: {
    clearMocks: true,
    restoreMocks: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'main',
          environment: 'node',
          include: ['tests/unit/common/**/*.test.ts', 'tests/unit/main/**/*.test.ts']
        }
      },
      {
        extends: true,
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['tests/unit/renderer/**/*.test.ts'],
          setupFiles: ['tests/unit/setup/renderer.ts']
        }
      }
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/common/password.ts']
    }
  }
})
