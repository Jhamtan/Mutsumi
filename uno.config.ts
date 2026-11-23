import {
  defineConfig,
  presetAttributify,
  presetIcons,
  presetWind3,
  transformerDirectives
} from 'unocss'

/**
 * UnoCSS configuration for the renderer: design tokens (colors, fonts, shadows)
 * and reusable utility shortcuts used across the UI.
 */

export default defineConfig({
  presets: [presetAttributify(), presetIcons(), presetWind3()],
  transformers: [transformerDirectives()],
  theme: {
    colors: {
      brand: {
        50: '#F2FBF6',
        100: '#E1F5E9',
        200: '#C5EBD6',
        300: '#9CDABB',
        400: '#6DC29C',
        500: '#45A77E',
        600: '#2F8563',
        700: '#286A51',
        light: '#E1F5E9',
        DEFAULT: '#45A77E',
        dark: '#286A51'
      },
      accent: {
        50: '#F0F7FF',
        100: '#E1EEFC',
        200: '#C5DDF7',
        300: '#A2C6ED',
        400: '#79A9DF',
        500: '#538BCB',
        600: '#3974B6',
        700: '#2D629E',
        800: '#284F7D',
        DEFAULT: '#3974B6'
      },
      ink: {
        DEFAULT: '#233E46',
        muted: '#607780',
        soft: '#72858D'
      },
      canvas: '#F5F9F8'
    },
    fontFamily: {
      sans: '"Inter", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    },
    boxShadow: {
      panel: '0 24px 80px -28px rgba(42, 83, 101, 0.22), 0 2px 8px rgba(42, 83, 101, 0.03)',
      button: '0 6px 16px -6px rgba(45, 98, 158, 0.45)'
    }
  },
  shortcuts: {
    'app-page': 'relative h-full w-full overflow-x-hidden overflow-y-auto bg-canvas text-ink',
    'app-surface': 'border border-solid border-white/90 bg-white/90 shadow-panel',
    'brand-symbol':
      'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-100 text-brand-700',
    'locale-button':
      'inline-flex h-9 items-center justify-center gap-2 rounded-full border border-solid border-accent-200 bg-white/80 px-3 text-xs font-semibold text-accent-700 cursor-pointer transition-colors hover:bg-accent-50',
    'btn-primary':
      'inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border-none bg-accent-700 px-5 py-3 text-sm font-semibold text-white shadow-button cursor-pointer transition-all duration-200 hover:bg-accent-800 active:translate-y-px disabled:cursor-wait disabled:opacity-65',
    'btn-secondary':
      'inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-solid border-accent-200 bg-accent-50 px-5 py-3 text-sm font-semibold text-accent-700 cursor-pointer transition-colors hover:bg-accent-100',
    'text-link': 'font-semibold text-accent-700 no-underline underline-offset-4 hover:underline',
    eyebrow: 'text-xs font-semibold tracking-[0.18em] uppercase text-brand-700',
    // Page scaffolding: Shared by the list/details/edit pages after login.
    'page-container': 'h-full overflow-y-auto p-9',
    'page-head': 'flex items-end justify-between gap-5 mx-auto mb-6',
    'page-head-title': 'mt-1.5 text-[26px] font-semibold tracking-[-0.03em]',
    'page-subtitle': 'mt-[5px] text-[13px] text-ink-muted',
    'card-grid': 'grid gap-[18px] mx-auto max-w-[1040px]',
    'empty-state':
      'flex min-h-[260px] flex-col items-center justify-center mx-auto rounded-[20px] border border-dashed border-[#d5e5e3] bg-white/55 text-center',
    'empty-icon':
      'inline-flex h-[52px] w-[52px] items-center justify-center mb-3 rounded-2xl bg-brand-100 text-brand-700 text-2xl',
    'empty-title': 'text-base font-semibold',
    'empty-hint': 'mt-1.5 text-xs text-ink-soft',
    'back-link':
      'inline-flex items-center gap-1.5 border-none bg-transparent text-[13px] text-ink-muted cursor-pointer hover:text-brand-700'
  }
})
