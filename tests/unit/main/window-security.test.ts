import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getSafeExternalUrl,
  isAllowedRendererNavigation
} from '../../../src/main/window/navigation-policy'

const mocks = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exposed: new Map<string, any>(),
  send: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}))
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: unknown) => mocks.exposed.set(name, api)
  },
  ipcRenderer: {
    send: mocks.send,
    invoke: mocks.invoke,
    on: mocks.on,
    removeListener: mocks.removeListener
  }
}))

// 仅解析入口源码并执行提取的纯回调，不导入主入口，不启动 Electron 或数据库。
const mainSource = readFileSync(new URL('../../../src/main/index.ts', import.meta.url), 'utf8')
const mainAst = ts.createSourceFile('index.ts', mainSource, ts.ScriptTarget.Latest, true)

function getCallback(method: string, eventName?: string): string {
  let callback: ts.Expression | undefined
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === method &&
      node.expression.expression.getText(mainAst).startsWith('mainWindow.webContents') &&
      (!eventName ||
        (ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === eventName))
    ) {
      callback = node.arguments[eventName ? 1 : 0]
    }
    ts.forEachChild(node, visit)
  }
  visit(mainAst)
  if (!callback) throw new Error(`缺少窗口回调 ${method} ${eventName ?? ''}`)
  return callback.getText(mainAst)
}

const rendererUrl = 'file:///synthetic/renderer/index.html'

beforeEach(() => {
  mocks.exposed.clear()
  mocks.send.mockReset()
  mocks.invoke.mockReset()
  mocks.on.mockReset()
  mocks.removeListener.mockReset()
})

describe('窗口 URL 纯策略', () => {
  it.each([rendererUrl, `${rendererUrl}#/home`, `${rendererUrl}#login`])(
    '允许精确登记页面及 hash：%s',
    (url) => {
      expect(isAllowedRendererNavigation(url, rendererUrl)).toBe(true)
    }
  )

  it.each([
    'file:///synthetic/renderer/other.html',
    'file:///synthetic/renderer/index.html.evil',
    `${rendererUrl}?other=1`,
    'https://external.example.test/',
    'javascript:alert(1)',
    'custom:open',
    'data:text/html,test',
    'not-a-url'
  ])('拒绝非登记页面导航：%s', (url) => {
    expect(isAllowedRendererNavigation(url, rendererUrl)).toBe(false)
  })

  it('开发窗口也仅允许精确 URL，不放行同源或前缀相似页面', () => {
    const devUrl = 'http://localhost:5173/'
    expect(isAllowedRendererNavigation(`${devUrl}#/home`, devUrl)).toBe(true)
    expect(isAllowedRendererNavigation(`${devUrl}other`, devUrl)).toBe(false)
    expect(isAllowedRendererNavigation('http://localhost:51730/', devUrl)).toBe(false)
    expect(isAllowedRendererNavigation('http://user:pass@localhost:5173/', devUrl)).toBe(false)
  })

  it.each(['https://external.example.test/path#anchor', 'http://external.example.test/'])(
    '允许无凭据 HTTP(S) 外链：%s',
    (url) => {
      expect(getSafeExternalUrl(url)).toBe(url)
    }
  )

  it.each([
    rendererUrl,
    'javascript:alert(1)',
    'custom:open',
    'data:text/html,test',
    'ftp://external.example.test/',
    'https://user:pass@external.example.test/',
    'https://user@external.example.test/',
    'https://:pass@external.example.test/',
    'https://',
    'https://bad host/',
    'not-a-url'
  ])('拒绝危险或含凭据外链：%s', (url) => {
    expect(getSafeExternalUrl(url)).toBeNull()
  })
})

describe('主入口静态回归', () => {
  it('BrowserWindow 明确开启沙箱与隔离，关闭 Node 并开启 Web 安全', () => {
    let preferences: ts.ObjectLiteralExpression | undefined
    function visit(node: ts.Node): void {
      if (ts.isNewExpression(node) && node.expression.getText(mainAst) === 'BrowserWindow') {
        const options = node.arguments?.[0]
        if (options && ts.isObjectLiteralExpression(options)) {
          const property = options.properties.find(
            (item) =>
              ts.isPropertyAssignment(item) && item.name.getText(mainAst) === 'webPreferences'
          )
          if (
            property &&
            ts.isPropertyAssignment(property) &&
            ts.isObjectLiteralExpression(property.initializer)
          ) {
            preferences = property.initializer
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(mainAst)
    expect(preferences).toBeDefined()
    const properties = Object.fromEntries(
      preferences!.properties
        .filter(ts.isPropertyAssignment)
        .map((property) => [property.name.getText(mainAst), property.initializer.getText(mainAst)])
    )
    expect(properties).toMatchObject({
      sandbox: 'true',
      contextIsolation: 'true',
      nodeIntegration: 'false',
      webSecurity: 'true'
    })
  })

  it.each(['will-navigate', 'will-frame-navigate', 'will-redirect'])(
    '入口对 %s 使用精确 URL 策略并阻止外部导航',
    (eventName) => {
      const callback = runInNewContext(`(${getCallback('on', eventName)})`, {
        rendererUrl,
        isAllowedRendererNavigation
      })
      const preventDefault = vi.fn()
      callback({ url: `${rendererUrl}#/home`, preventDefault })
      expect(preventDefault).not.toHaveBeenCalled()
      for (const url of [
        'https://external.example.test/',
        'javascript:alert(1)',
        'custom:open',
        'file:///other.html'
      ]) {
        callback({ url, preventDefault })
      }
      expect(preventDefault).toHaveBeenCalledTimes(4)
    }
  )

  it('权限请求和检查全部默认拒绝', () => {
    const callback = vi.fn()
    const request = runInNewContext(`(${getCallback('setPermissionRequestHandler')})`)
    const check = runInNewContext(`(${getCallback('setPermissionCheckHandler')})`)
    request({}, 'media', callback)
    expect(callback).toHaveBeenCalledWith(false)
    expect(check()).toBe(false)
  })

  it('新窗口始终拒绝，危险 URL 不传给 shell，拒绝的 Promise 不记录原 URL', async () => {
    const openExternal = vi.fn().mockRejectedValue(new Error('synthetic-private-url'))
    const warn = vi.fn()
    const callback = runInNewContext(`(${getCallback('setWindowOpenHandler')})`, {
      getSafeExternalUrl,
      shell: { openExternal },
      console: { warn }
    })
    for (const url of [
      'file:///other.html',
      'javascript:alert(1)',
      'custom:open',
      'https://user:pass@external.example.test/'
    ]) {
      expect(callback({ url })).toEqual({ action: 'deny' })
    }
    expect(openExternal).not.toHaveBeenCalled()
    const url = 'https://external.example.test/path'
    expect(callback({ url })).toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledWith(url)
    await Promise.resolve()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warn.mock.calls)).not.toContain(url)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('synthetic-private-url')
  })

  it('入口不再使用裸 userId 磁盘会话恢复', () => {
    expect(mainSource).not.toMatch(/sessionStore|restoreSession|onSessionChange/)
    expect(mainSource).toContain('trustIpcSender(mainWindow.webContents, rendererUrl)')
  })
})

describe('开发依赖预构建回归', () => {
  it('预构建首次进入行程及新建页面的组件依赖，避免刷新撤销会话', () => {
    const configSource = readFileSync(
      new URL('../../../electron.vite.config.ts', import.meta.url),
      'utf8'
    )
    const configAst = ts.createSourceFile('config.ts', configSource, ts.ScriptTarget.Latest, true)
    let includesExpression: ts.Expression | undefined
    function visit(node: ts.Node): void {
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(configAst) === 'optimizeDeps' &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        const includes = node.initializer.properties.find(
          (property) =>
            ts.isPropertyAssignment(property) && property.name.getText(configAst) === 'include'
        )
        if (includes && ts.isPropertyAssignment(includes)) includesExpression = includes.initializer
      }
      ts.forEachChild(node, visit)
    }
    visit(configAst)
    expect(includesExpression).toBeDefined()
    const includes: unknown = runInNewContext(`(${includesExpression!.getText(configAst)})`)
    expect(includes).toEqual(
      expect.arrayContaining([
        'element-plus/es',
        ...[
          'base',
          'message-box',
          'skeleton',
          'date-picker',
          'input-number',
          'option',
          'select'
        ].map((component) => `element-plus/es/components/${component}/style/css`)
      ])
    )
  })
})

describe('测试启动入口回归', () => {
  const launcherSource = readFileSync(
    new URL('../../../scripts/run-vitest.mjs', import.meta.url),
    'utf8'
  )
  const launcherAst = ts.createSourceFile(
    'launcher.mjs',
    launcherSource,
    ts.ScriptTarget.Latest,
    true
  )
  const canonicalPathExpression = launcherAst.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find(
      (declaration) =>
        ts.isIdentifier(declaration.name) && declaration.name.text === 'canonicalCliPath'
    )?.initializer

  it.each([
    ['e:/项目目录/test #1/vitest.mjs', 'win32', 'E:/项目目录/test #1/vitest.mjs'],
    ['E:\\project\\vitest.mjs', 'win32', 'E:\\project\\vitest.mjs'],
    ['\\\\server\\share\\vitest.mjs', 'win32', '\\\\server\\share\\vitest.mjs'],
    ['/workspace/vitest.mjs', 'linux', '/workspace/vitest.mjs'],
    ['e:/workspace/vitest.mjs', 'darwin', 'e:/workspace/vitest.mjs']
  ])('只规范化 Windows 盘符，不改目录或其他平台路径：%s (%s)', (cliPath, platform, expected) => {
    expect(canonicalPathExpression).toBeDefined()
    const actual: unknown = runInNewContext(`(${canonicalPathExpression!.getText(launcherAst)})`, {
      cliPath,
      process: { platform }
    })
    expect(actual).toBe(expected)
  })

  it('所有测试命令复用统一入口且保留命令行参数', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')
    ) as { scripts: Record<string, string> }
    expect(manifest.scripts).toMatchObject({
      'test:unit': 'node scripts/run-vitest.mjs run',
      'test:security': 'node scripts/run-vitest.mjs run --config vitest.security.config.mts',
      'test:watch': 'node scripts/run-vitest.mjs',
      'test:coverage': 'node scripts/run-vitest.mjs run --coverage'
    })
    expect(launcherSource).toContain('process.argv[1] = canonicalCliPath')
    expect(launcherSource).not.toMatch(/process\.argv\s*=/)
    expect(launcherSource).toContain('await import(pathToFileURL(canonicalCliPath).href)')
  })
})

describe('沙箱 preload 最小桥接', () => {
  it('只依赖 Electron，不挂载无隔离后备或泛化 toolkit API', () => {
    const preloadSource = readFileSync(
      new URL('../../../src/preload/index.ts', import.meta.url),
      'utf8'
    )
    const source = ts.createSourceFile('preload.ts', preloadSource, ts.ScriptTarget.Latest, true)
    const runtimeImports = source.statements
      .filter(ts.isImportDeclaration)
      .map((declaration) => (declaration.moduleSpecifier as ts.StringLiteral).text)
    expect(runtimeImports).toEqual(['electron'])
    expect(preloadSource).not.toMatch(
      /window\.(api|electron)\s*=|electronAPI|@electron-toolkit\/preload/
    )
  })

  it('vue-app-ready 保持可用但任意通道被拒绝', async () => {
    vi.resetModules()
    await import('../../../src/preload/index')
    const electron = mocks.exposed.get('electron')
    expect(Object.keys(electron)).toEqual(['ipcRenderer'])
    expect(Object.keys(electron.ipcRenderer)).toEqual(['send'])
    electron.ipcRenderer.send('vue-app-ready')
    electron.ipcRenderer.send('synthetic:arbitrary-channel', 'payload')
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith('vue-app-ready')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('固定业务接口保留，关闭事件不泄漏 Electron event', async () => {
    vi.resetModules()
    await import('../../../src/preload/index')
    const api = mocks.exposed.get('api')
    expect(api.send).toBeUndefined()
    expect(api.invoke).toBeUndefined()
    api.login('synthetic@example.test', 'SyntheticPassword42')
    expect(mocks.invoke).toHaveBeenCalledWith('user:login', {
      email: 'synthetic@example.test',
      password: 'SyntheticPassword42'
    })
    const callback = vi.fn()
    const unsubscribe = api.onCloseQuery(callback)
    const listener = mocks.on.mock.calls[0][1]
    listener({ syntheticSecret: true }, 'ask')
    expect(callback).toHaveBeenCalledExactlyOnceWith('ask')
    unsubscribe()
    expect(mocks.removeListener).toHaveBeenCalledWith('app:close-query', listener)
  })
})
