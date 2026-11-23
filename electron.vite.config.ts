import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import Icons from 'unplugin-icons/vite'
import IconsResolver from 'unplugin-icons/resolver'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import UnoCSS from 'unocss/vite'
import Inspect from 'vite-plugin-inspect'

/**
 * electron-vite build configuration: separate main, preload, and renderer
 * bundles, each with its own aliases and plugin chain.
 */

export default defineConfig({
  main: {
    build: {
      externalizeDeps: true
    },
    resolve: {
      alias: {
        '@common': resolve('src/common')
      }
    }
  },
  preload: {
    build: {
      externalizeDeps: true
    },
    resolve: {
      alias: {
        '@common': resolve('src/common')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@common': resolve('src/common')
      }
    },
    plugins: [
      vue(),
      AutoImport({
        // Auto import functions from Vue, e.g. ref, reactive, toRef...
        imports: ['vue', 'vue-router', 'pinia'],
        // Auto import functions from Element Plus, e.g. ElMessage, ElMessageBox... (with style)
        resolvers: [
          ElementPlusResolver(),
          // Auto import icon components
          IconsResolver({
            prefix: 'Icon'
          })
        ],
        vueTemplate: true,
        dts: resolve('src/renderer/src', 'typings', 'auto-imports.d.ts'),
        eslintrc: {
          // Set to true to generate the file; after generation, you can change it back to false
          // to avoid generating the file every time you restart.
          enabled: false,
          filepath: resolve('src/renderer/src', 'typings', '.eslintrc-auto-import.json'),
          globalsPropValue: true
        }
      }),
      Components({
        resolvers: [
          // Auto register icon components
          IconsResolver({
            enabledCollections: ['ep']
          }),
          // Auto register Element Plus components
          ElementPlusResolver()
        ],
        dts: resolve('src/renderer/src', 'typings', 'components.d.ts')
      }),
      Icons({
        autoInstall: true
      }),
      UnoCSS(),
      Inspect()
    ]
  }
})
