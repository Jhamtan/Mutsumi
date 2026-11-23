import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'

export default defineConfig({
  plugins: [vue(), AutoImport({ imports: ['vue', 'vue-router', 'pinia'], dts: false })],
  resolve: {
    alias: {
      '@common': fileURLToPath(new URL('./src/common', import.meta.url)),
      '@renderer': fileURLToPath(new URL('./src/renderer/src', import.meta.url))
    }
  },
  test: {
    clearMocks: true,
    restoreMocks: true,
    // Security tests create scratch dirs under os.tmpdir() with shared prefixes;
    // running test files sequentially keeps those assertions deterministic.
    fileParallelism: false,
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
