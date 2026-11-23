/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const { z } = require('zod')
const logs = []
const loggerPath = path.resolve(__dirname, '../src/main/logger.ts')
require.cache[loggerPath] = {
  id: loggerPath,
  filename: loggerPath,
  loaded: true,
  exports: { __esModule: true, default: { error: (...args) => logs.push(args) } }
}
require.extensions['.ts'] = (module, filename) => {
  const out = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  })
  module._compile(out.outputText, filename)
}
const {
  trustIpcSender,
  assertTrustedSender,
  setSession,
  clearSession,
  requireSession
} = require('../src/main/ipc/security.ts')
const { handleWithValidation } = require('../src/main/ipc/validator.ts')
const { CreateUserSchema, LoginSchema } = require('../src/main/ipc/schemas.ts')
const { isValidPlaintextPassword } = require('../src/common/password.ts')
delete require.extensions['.ts']
function event(url = 'file:///app/index.html#/login') {
  const sender = new EventEmitter()
  sender.isDestroyed = () => false
  sender.mainFrame = { url }
  trustIpcSender(sender, 'file:///app/index.html')
  return { sender, senderFrame: sender.mainFrame }
}

test('only registered main frames at the exact renderer URL are accepted', () => {
  const trusted = event()
  assert.doesNotThrow(() => assertTrustedSender(trusted))
  assert.throws(
    () => assertTrustedSender({ ...trusted, senderFrame: { url: trusted.senderFrame.url } }),
    { code: 'IPC_FORBIDDEN' }
  )
  trusted.senderFrame.url = 'https://evil.example/'
  assert.throws(() => assertTrustedSender(trusted), { code: 'IPC_FORBIDDEN' })
  trusted.senderFrame.url = 'file:///app/other.html'
  assert.throws(() => assertTrustedSender(trusted), { code: 'IPC_FORBIDDEN' })
  trusted.sender.emit('destroyed')
  assert.throws(() => assertTrustedSender(trusted), { code: 'IPC_FORBIDDEN' })
})

test('development URL allows hash routing but rejects other pages', () => {
  const trusted = event('http://localhost:5173/#/login')
  trustIpcSender(trusted.sender, 'http://localhost:5173')
  assert.doesNotThrow(() => assertTrustedSender(trusted))
  trusted.senderFrame.url = 'http://localhost:5173/other'
  assert.throws(() => assertTrustedSender(trusted), { code: 'IPC_FORBIDDEN' })
})

test('sessions are scoped to sender and cleared on logout, navigation and destruction', () => {
  const first = event()
  const second = event()
  setSession(first, 12)
  assert.equal(requireSession(first), 12)
  assert.throws(() => requireSession(second), { code: 'AUTH_REQUIRED' })
  clearSession(first)
  assert.throws(() => requireSession(first), { code: 'AUTH_REQUIRED' })
  setSession(first, 12)
  first.sender.emit('did-start-navigation', {}, '', false, true)
  assert.throws(() => requireSession(first), { code: 'AUTH_REQUIRED' })
  setSession(first, 12)
  first.sender.emit('destroyed')
  assert.throws(() => requireSession(first), { code: 'IPC_FORBIDDEN' })
})

test('IPC rejects untrusted senders before running validation or handlers', async () => {
  let called = false
  const wrapped = handleWithValidation(z.string(), async () => {
    called = true
    return 'ok'
  })
  const untrusted = event()
  untrusted.senderFrame.url = 'https://evil.example'
  assert.equal((await wrapped(untrusted, 'input')).code, 'IPC_FORBIDDEN')
  assert.equal(called, false)
})

test('validation and handler exceptions are contained and never logged verbatim', async () => {
  const secret = 'private diary text'
  const wrapped = handleWithValidation(
    z.string().transform(() => {
      throw new Error(secret)
    }),
    async () => null
  )
  assert.equal((await wrapped(event(), secret)).code, 'INTERNAL_ERROR')
  const failing = handleWithValidation(z.string(), async () => {
    throw new Error(secret)
  })
  assert.equal((await failing(event(), secret)).code, 'INTERNAL_ERROR')
  assert.equal(JSON.stringify(logs).includes(secret), false)
  assert.equal(
    (await handleWithValidation(z.string(), async (value) => value)(event(), 123)).code,
    'INVALID_INPUT'
  )
})

test('password policy rejects UTF-8 truncation for new and login passwords', () => {
  const input = { name: 'Test', email: 'test@example.com', password: '中'.repeat(24) + '甲' }
  assert.equal(CreateUserSchema.safeParse(input).success, false)
  assert.equal(isValidPlaintextPassword(input.password), false)
  assert.equal(CreateUserSchema.safeParse({ ...input, password: '中'.repeat(24) }).success, true)
  // 登录与注册一致：超过 72 字节的密码同样被拒绝，避免 bcrypt 截断
  assert.equal(
    LoginSchema.safeParse({ email: input.email, password: input.password }).success,
    false
  )
  assert.equal(
    LoginSchema.safeParse({ email: input.email, password: '中'.repeat(24) }).success,
    true
  )
  assert.equal(
    LoginSchema.safeParse({ email: input.email, password: 'a'.repeat(100000) }).success,
    false
  )
})
