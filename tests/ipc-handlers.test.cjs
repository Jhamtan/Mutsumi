/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const handlers = new Map()
let existing = null
let creationError = null
let loginUser = null
let lastLookupOptions
let lastCreateOptions
const transaction = { id: 'registration-transaction' }
let committed = 0
let rolledBack = 0
class FakeRepository {
  async transaction(operation) {
    try {
      const result = await operation(transaction)
      committed++
      return result
    } catch (error) {
      rolledBack++
      throw error
    }
  }
  async findByEmail(_email, options) {
    lastLookupOptions = options
    return existing
  }
  async create(_data, options) {
    lastCreateOptions = options
    if (creationError) throw creationError
    return { toJSON: () => ({ id: 1 }) }
  }
  async findUserForLogin() {
    return loginUser
  }
}
const loggerPath = path.resolve(__dirname, '../src/main/logger.ts')
require.cache[loggerPath] = {
  id: loggerPath,
  filename: loggerPath,
  loaded: true,
  exports: { __esModule: true, default: { error: () => undefined } }
}
const load = Module._load
Module._load = function (name, ...rest) {
  if (name === 'electron')
    return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } }
  if (name === '../../database/repositories/UserRepository')
    return { __esModule: true, default: FakeRepository }
  if (name === './handlers/notebook-handlers') return { registerNotebookHandlers: () => undefined }
  if (name === './handlers/diary-handlers') return { registerDiaryHandlers: () => undefined }
  if (name === './handlers/backup-handlers') return { registerBackupHandlers: () => undefined }
  if (name === './handlers/itinerary-handlers') return { registerItineraryHandlers: () => undefined }
  if (name === './handlers/photowall-handlers') return { registerPhotoWallHandlers: () => undefined }
  return load.call(this, name, ...rest)
}
require.extensions['.ts'] = (module, filename) => {
  const out = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  })
  module._compile(out.outputText, filename)
}
const { registerIpcHandlers } = require('../src/main/ipc/handlers.ts')
const { trustIpcSender, requireSession } = require('../src/main/ipc/security.ts')
const { AppError } = require('../src/main/errors.ts')
registerIpcHandlers()
Module._load = load
delete require.extensions['.ts']
const input = { name: 'Test', email: 'test@example.com', password: 'test-password' }
function event() {
  const sender = new EventEmitter()
  sender.mainFrame = { url: 'file:///app/index.html' }
  sender.isDestroyed = () => false
  trustIpcSender(sender, sender.mainFrame.url)
  return { sender, senderFrame: sender.mainFrame }
}

test('registration reserves deleted emails and normalizes unique-constraint race errors', async () => {
  const source = event()
  existing = { id: 1 }
  assert.equal((await handlers.get('user:create')(source, input)).code, 'EMAIL_EXISTS')
  assert.deepEqual(lastLookupOptions, { transaction, paranoid: false })
  assert.equal(rolledBack, 1)
  existing = null
  creationError = new AppError('Duplicate', 'DATA_EXISTS')
  assert.equal((await handlers.get('user:create')(source, input)).code, 'EMAIL_EXISTS')
  assert.equal(rolledBack, 2)
  creationError = null
  assert.equal((await handlers.get('user:create')(source, input)).success, true)
  assert.deepEqual(lastCreateOptions, { transaction })
  assert.equal(committed, 1)
})

test('login establishes main-process identity, failed login and logout clear it', async () => {
  const source = event()
  loginUser = { id: 42, comparePassword: async () => true, toJSON: () => ({ id: 42 }) }
  assert.equal((await handlers.get('user:login')(source, input)).success, true)
  assert.equal(requireSession(source), 42)
  loginUser = null
  assert.equal((await handlers.get('user:login')(source, input)).code, 'AUTH_FAILED')
  assert.throws(() => requireSession(source), { code: 'AUTH_REQUIRED' })
  loginUser = { id: 42, comparePassword: async () => true, toJSON: () => ({ id: 42 }) }
  await handlers.get('user:login')(source, input)
  assert.equal((await handlers.get('user:logout')(source, undefined)).success, true)
  assert.throws(() => requireSession(source), { code: 'AUTH_REQUIRED' })
})
