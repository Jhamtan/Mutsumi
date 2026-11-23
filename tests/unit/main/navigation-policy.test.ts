import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  getSafeExternalUrl,
  isAllowedRendererNavigation
} from '../../../src/main/window/navigation-policy'

const renderer = 'file:///synthetic/index.html'
describe('independent renderer navigation policy', () => {
  it('allows only the exact renderer document plus hash routes', () => {
    expect(isAllowedRendererNavigation(renderer + '#/home', renderer)).toBe(true)
    for (const target of [
      renderer + '?different=1',
      'file:///synthetic/other.html',
      'https://example.test/',
      'not a URL'
    ]) {
      expect(isAllowedRendererNavigation(target, renderer)).toBe(false)
    }
  })
  it('does not broaden development server trust to another path or port', () => {
    const development = 'http://localhost:5173/'
    expect(isAllowedRendererNavigation(development + '#/login', development)).toBe(true)
    expect(isAllowedRendererNavigation('http://localhost:5174/', development)).toBe(false)
    expect(isAllowedRendererNavigation(development + 'other', development)).toBe(false)
  })
  it('opens only credential-free HTTP and HTTPS URLs externally', () => {
    expect(getSafeExternalUrl('https://example.test/page')).toBe('https://example.test/page')
    expect(getSafeExternalUrl('http://example.test/')).toBe('http://example.test/')
    for (const target of [
      'file:///synthetic/index.html',
      'app://example',
      'javascript:void(0)',
      'data:text/plain,x',
      'invalid'
    ]) {
      expect(getSafeExternalUrl(target)).toBeNull()
    }
    const withCredentials = new URL('https://example.test/')
    withCredentials.username = 'synthetic'
    withCredentials.password = randomBytes(8).toString('hex')
    expect(getSafeExternalUrl(withCredentials.href)).toBeNull()
    expect(isAllowedRendererNavigation(withCredentials.href, withCredentials.href)).toBe(false)
  })
  it('retains explicit window isolation and a fixed preload boundary', () => {
    const main = readFileSync(new URL('../../../src/main/index.ts', import.meta.url), 'utf8')
    const preload = readFileSync(new URL('../../../src/preload/index.ts', import.meta.url), 'utf8')
    for (const setting of [
      'sandbox: true',
      'contextIsolation: true',
      'nodeIntegration: false',
      'webSecurity: true'
    ]) {
      expect(main).toContain(setting)
    }
    expect(main).not.toContain('restoreSession')
    expect(preload).not.toContain('@electron-toolkit/preload')
    expect(preload).toContain("channel === 'vue-app-ready'")
    expect(preload).toContain("ipcRenderer.invoke('user:login'")
  })
})
