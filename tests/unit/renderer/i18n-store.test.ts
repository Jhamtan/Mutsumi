import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useI18nStore } from '../../../src/renderer/src/store/i18n'

/**
 * Tests the i18n store: default locale, reactive dictionary switching, and
 * parity of keys/placeholders across Chinese and English.
 */
beforeEach(() => setActivePinia(createPinia()))

describe('useI18nStore', () => {
  it('defaults to Chinese', () => {
    const store = useI18nStore()
    expect(store.locale).toBe('zh')
    expect(store.t.login.title).toBe('欢迎回来')
  })

  it('switches dictionaries reactively and toggles back', () => {
    const store = useI18nStore()
    store.toggleLocale()
    expect(store.locale).toBe('en')
    expect(store.t.login.title).toBe('Welcome back')
    expect(store.t.common.switchLanguage).toBe('Switch to Chinese')
    store.toggleLocale()
    expect(store.locale).toBe('zh')
    expect(store.t.login.title).toBe('欢迎回来')
  })

  it('provides matching nonempty keys and placeholders in both dictionaries', () => {
    const store = useI18nStore()
    const chinese = store.t
    store.toggleLocale()
    const english = store.t

    // Recursively compare both dictionaries to guarantee identical keys and nonempty strings.
    const verifyDictionary = (left: unknown, right: unknown) => {
      if (typeof left === 'string' && typeof right === 'string') {
        expect(left.trim().length).toBeGreaterThan(0)
        expect(right.trim().length).toBeGreaterThan(0)
        return
      }

      expect(typeof left).toBe('object')
      expect(typeof right).toBe('object')
      expect(left).not.toBeNull()
      expect(right).not.toBeNull()
      const leftRecord = left as Record<string, unknown>
      const rightRecord = right as Record<string, unknown>
      expect(Object.keys(rightRecord).sort()).toEqual(Object.keys(leftRecord).sort())
      for (const key of Object.keys(leftRecord)) {
        verifyDictionary(leftRecord[key], rightRecord[key])
      }
    }

    verifyDictionary(chinese, english)
    expect(chinese.home.greeting).toContain('{name}')
    expect(english.home.greeting).toContain('{name}')
  })
})
