import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

export default defineConfig(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      'coverage',
      'outputs',
      'src/renderer/src/typings/*.d.ts',
      'src/renderer/src/typings/*.json'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        },
        extraFileExtensions: ['.vue'],
        parser: tseslint.parser
      }
    },
    // Auto-imported symbols (ref, computed, useRoute, ElMessage, ...) are
    // resolved by the bundler and typed via the generated declaration files;
    // TypeScript already rejects genuinely undefined identifiers.
    rules: {
      'no-undef': 'off'
    }
  },
  {
    files: ['**/*.{ts,mts,tsx,vue}'],
    rules: {
      'vue/require-default-prop': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/block-lang': [
        'error',
        {
          script: {
            lang: 'ts'
          }
        }
      ]
    }
  },
  {
    files: ['src/renderer/**/*.{ts,vue}', 'tests/unit/**/*.ts'],
    rules: {
      // Renderer code relies on Vue composition and component handlers whose
      // types are inferred, so an explicit return type adds little value.
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  eslintConfigPrettier
)
