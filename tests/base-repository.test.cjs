// CommonJS 测试加载器需要 require；此文件是 JavaScript，不使用 TypeScript 返回类型标注
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test, before, after } = require('node:test')
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto')
const ts = require('typescript')
require('reflect-metadata')
const { Sequelize } = require('sequelize-typescript')
const { Model, DataTypes, DatabaseError } = require('sequelize')

// 编译真实 TypeScript 模块，只替换 Electron 日志依赖；数据库和模型钩子都使用真实实现
const root = path.resolve(__dirname, '..')
const errors = []
const loggerPath = path.join(root, 'src/main/logger.ts')
require.cache[loggerPath] = {
  id: loggerPath,
  filename: loggerPath,
  loaded: true,
  exports: { __esModule: true, default: { error: (...args) => errors.push(args) } }
}
const previousLoader = require.extensions['.ts']
require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      useDefineForClassFields: true
    }
  })
  module._compile(outputText, filename)
}
const { BaseRepository } = require('../src/main/database/repositories/BaseRepository.ts')
const { User } = require('../src/main/database/models/user.model.ts')
const { Notebook } = require('../src/main/database/models/notebook.model.ts')
const { Diary: AppDiary } = require('../src/main/database/models/diary.model.ts')
const { DiaryImage } = require('../src/main/database/models/diary-image.model.ts')
const { default: UserRepository } = require('../src/main/database/repositories/UserRepository.ts')
const { AppError } = require('../src/main/errors.ts')
if (previousLoader) require.extensions['.ts'] = previousLoader
else delete require.extensions['.ts']

const sqlLogs = []
const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: ':memory:',
  models: [User, Notebook, AppDiary, DiaryImage],
  logging: (sql) => sqlLogs.push(sql)
})
const key = randomBytes(32)
const destroyedIds = []
class Diary extends Model {}
Diary.init(
  {
    content: {
      type: DataTypes.TEXT,
      allowNull: false,
      get() {
        const stored = this.getDataValue('content')
        const iv = this.getDataValue('iv')
        const tag = this.getDataValue('tag')
        if (!iv || !tag) return stored
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'))
        decipher.setAuthTag(Buffer.from(tag, 'hex'))
        return Buffer.concat([
          decipher.update(Buffer.from(stored, 'hex')),
          decipher.final()
        ]).toString('utf8')
      }
    },
    title: { type: DataTypes.STRING, allowNull: false },
    iv: DataTypes.STRING,
    tag: DataTypes.STRING
  },
  {
    sequelize,
    tableName: 'test_diaries',
    paranoid: true,
    version: true,
    hooks: {
      beforeSave(instance) {
        if (!instance.changed('content')) return
        const iv = randomBytes(12)
        const cipher = createCipheriv('aes-256-gcm', key, iv)
        const encrypted = Buffer.concat([
          cipher.update(instance.getDataValue('content'), 'utf8'),
          cipher.final()
        ])
        instance.setDataValue('content', encrypted.toString('hex'))
        instance.setDataValue('iv', iv.toString('hex'))
        instance.setDataValue('tag', cipher.getAuthTag().toString('hex'))
      },
      beforeDestroy(instance) {
        destroyedIds.push(instance.id)
      }
    }
  }
)
class DiaryRepository extends BaseRepository {
  constructor() {
    super(Diary, ['content', 'title'])
  }

  deleteByTitle(title, id, force = false) {
    return this.deleteScoped(id, force, { title }, [])
  }
}
let users
let diaries
let emailSequence = 0
const userInput = () => ({
  name: 'Test User',
  email: `test-${++emailSequence}@example.com`,
  password: 'initial-password'
})
const hasCode = (code) => (error) => error instanceof AppError && error.code === code

before(async () => {
  users = new UserRepository()
  diaries = new DiaryRepository()
  await sequelize.sync({ force: true })
})
after(async () => {
  await sequelize.close()
})

test('create and update hash passwords; unrelated updates do not hash them again', async () => {
  const input = userInput()
  const user = await users.create(input)
  assert.notEqual(user.password, input.password)
  assert.equal(await user.comparePassword(input.password), true)

  assert.equal(await users.update(user.id, { password: 'changed-password' }), true)
  const updated = await User.findByPk(user.id, { logging: false })
  assert.notEqual(updated.password, 'changed-password')
  assert.equal(await updated.comparePassword('changed-password'), true)
  assert.equal(await updated.comparePassword(input.password), false)

  assert.equal(await users.update(user.id, { name: 'New Name' }), true)
  assert.equal((await User.findByPk(user.id, { logging: false })).password, updated.password)
})

test('queries return real instances and JSON serialization removes passwords', async () => {
  const user = await users.create(userInput())
  for (const found of [
    await users.findById(user.id),
    await users.findByEmail(user.email),
    ...(await users.findAll({ where: { id: user.id } }))
  ]) {
    assert.ok(found instanceof User)
    assert.equal(typeof found.comparePassword, 'function')
    assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(found)), 'password'), false)
  }
  const login = await users.findUserForLogin(user.email)
  assert.equal(await login.comparePassword('initial-password'), true)
})

test('runtime query options cannot bypass instances or afterFind hooks', async () => {
  const user = await users.create(userInput())
  let hookCalls = 0
  User.addHook('afterFind', 'test-after-find', () => {
    hookCalls++
  })
  try {
    const found = await users.findAll({ where: { id: user.id }, raw: true, hooks: false })
    assert.ok(found[0] instanceof User)
    assert.equal(hookCalls, 1)
  } finally {
    User.removeHook('afterFind', 'test-after-find')
  }
})

test('invalid passwords are rejected and existing hashes remain unchanged', async () => {
  const user = await users.create(userInput())
  for (const password of ['short', 'a'.repeat(31), null]) {
    await assert.rejects(users.update(user.id, { password }), hasCode('VALIDATION_ERROR'))
    assert.equal((await User.findByPk(user.id, { logging: false })).password, user.password)
  }
})

test('encryption hooks persist ciphertext and new IV/tag on creation and update', async () => {
  const diary = await diaries.create({ title: 'Private', content: 'first private entry' })
  const first = await Diary.findByPk(diary.id, { raw: true, logging: false })
  assert.notEqual(first.content, 'first private entry')
  assert.ok(first.iv)
  assert.ok(first.tag)
  assert.equal((await diaries.findById(diary.id)).content, 'first private entry')

  assert.equal(await diaries.update(diary.id, { content: 'updated private entry' }), true)
  const updated = await Diary.findByPk(diary.id, { raw: true, logging: false })
  assert.notEqual(updated.content, 'updated private entry')
  assert.notEqual(updated.iv, first.iv)
  assert.notEqual(updated.tag, first.tag)
  assert.equal((await diaries.findById(diary.id)).content, 'updated private entry')
  assert.equal(
    (await diaries.findAll({ where: { id: diary.id } }))[0].content,
    'updated private entry'
  )

  await diaries.update(diary.id, { title: 'New title' })
  const renamed = await Diary.findByPk(diary.id, { raw: true, logging: false })
  assert.equal(renamed.content, updated.content)
  assert.equal(renamed.iv, updated.iv)
  assert.equal(renamed.tag, updated.tag)
})

test('encryption hook failure never persists plaintext or logs it', async () => {
  const diary = await diaries.create({ title: 'Private', content: 'original' })
  const stored = await Diary.findByPk(diary.id, { raw: true, logging: false })
  const secret = 'secret in failing encryption hook'
  Diary.addHook('beforeUpdate', 'test-fail-encryption', () => {
    throw new Error(secret)
  })
  try {
    await assert.rejects(diaries.update(diary.id, { content: secret }), {
      message: 'Database operation failed'
    })
    assert.equal(
      (await Diary.findByPk(diary.id, { raw: true, logging: false })).content,
      stored.content
    )
    assert.equal(JSON.stringify(errors).includes(secret), false)
  } finally {
    Diary.removeHook('beforeUpdate', 'test-fail-encryption')
  }
})

test('soft deletion runs instance hooks and force deletion can purge a soft-deleted row', async () => {
  const diary = await diaries.create({ title: 'Private', content: 'delete me' })
  assert.equal(await diaries.delete(diary.id), true)
  assert.ok(destroyedIds.includes(diary.id))
  assert.equal(await diaries.findById(diary.id), null)
  assert.equal(await diaries.update(diary.id, { content: 'do not resurrect' }), false)
  assert.equal(await diaries.delete(diary.id), false)
  assert.ok(await Diary.findByPk(diary.id, { paranoid: false, logging: false }))
  assert.equal(await diaries.delete(diary.id, true), true)
  assert.equal(await Diary.findByPk(diary.id, { paranoid: false, logging: false }), null)
})

test('delete hook rejection leaves the row untouched', async () => {
  const diary = await diaries.create({ title: 'Protected', content: 'keep me' })
  Diary.addHook('beforeDestroy', 'test-protect-delete', () => {
    throw new AppError('Deletion is not allowed.', 'DELETE_BLOCKED')
  })
  try {
    await assert.rejects(diaries.delete(diary.id), hasCode('DELETE_BLOCKED'))
    await assert.rejects(diaries.delete(diary.id, true), hasCode('DELETE_BLOCKED'))
    assert.equal((await diaries.findById(diary.id)).content, 'keep me')
  } finally {
    Diary.removeHook('beforeDestroy', 'test-protect-delete')
  }
})

test('optimistic locking rejects stale updates and rolls back hook writes', async () => {
  const diary = await diaries.create({ title: 'Original', content: 'private' })
  Diary.addHook('beforeUpdate', 'test-concurrent-update', async () => {
    await Diary.update(
      { title: 'Concurrent change', version: diary.version + 1 },
      { where: { id: diary.id }, hooks: false, logging: false }
    )
  })
  try {
    await assert.rejects(
      diaries.update(diary.id, { title: 'Stale change' }),
      hasCode('DATA_CONFLICT')
    )
    assert.equal((await diaries.findById(diary.id)).title, 'Original')
    assert.equal((await diaries.findById(diary.id)).content, 'private')
  } finally {
    Diary.removeHook('beforeUpdate', 'test-concurrent-update')
  }
})

test('empty updates and missing rows return false', async () => {
  const user = await users.create(userInput())
  assert.equal(await users.update(user.id, {}), false)
  assert.equal(await users.update(user.id, { name: undefined }), false)
  assert.equal(await users.findById(999999), null)
  assert.equal(await users.update(999999, { name: 'Nobody' }), false)
  assert.equal(await users.delete(999999), false)
})

test('malformed IDs and non-boolean force flags are rejected', async () => {
  for (const id of [undefined, null, '1', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(users.findById(id), hasCode('INVALID_INPUT'))
    await assert.rejects(users.update(id, { name: 'Invalid' }), hasCode('INVALID_INPUT'))
    await assert.rejects(users.delete(id), hasCode('INVALID_INPUT'))
  }
  const user = await users.create(userInput())
  await assert.rejects(users.delete(user.id, 'false'), hasCode('INVALID_INPUT'))
  assert.ok(await users.findById(user.id))
})

test('create/update reject unknown, system and prototype fields at runtime', async () => {
  const user = await users.create(userInput())
  for (const field of ['id', 'createdAt', 'updatedAt', 'deletedAt', 'unknown', 'constructor']) {
    await assert.rejects(users.create({ ...userInput(), [field]: 123 }), hasCode('INVALID_INPUT'))
    await assert.rejects(users.update(user.id, { [field]: 123 }), hasCode('INVALID_INPUT'))
  }
  await assert.rejects(users.create(JSON.parse('{"__proto__":{}}')), hasCode('INVALID_INPUT'))
  for (const input of [
    null,
    undefined,
    [],
    'text',
    new Date(),
    Object.create({ name: 'inherited' })
  ]) {
    await assert.rejects(users.create(input), hasCode('INVALID_INPUT'))
    await assert.rejects(users.update(user.id, input), hasCode('INVALID_INPUT'))
  }
  const diary = await diaries.create({ title: 'Private', content: 'original' })
  for (const field of ['iv', 'tag', 'version']) {
    await assert.rejects(
      diaries.update(diary.id, { [field]: 'tampered' }),
      hasCode('INVALID_INPUT')
    )
  }
})

test('invalid writable-field configuration fails closed', () => {
  for (const fields of [['id'], ['createdAt'], ['version'], ['unknown']]) {
    assert.throws(() => new BaseRepository(Diary, fields), /writable business attributes only/)
  }
})

test('duplicate fields produce business errors without exposing input values', async () => {
  const input = userInput()
  await users.create(input)
  await assert.rejects(users.create(input), (error) => {
    assert.equal(error.code, 'DATA_EXISTS')
    assert.equal(error.message.includes(input.email), false)
    assert.equal(error.message.includes(input.password), false)
    return true
  })
})

test('SQL and full database errors never reach repository logs', async () => {
  sqlLogs.length = 0
  const user = await users.create(userInput())
  await users.findById(user.id)
  await users.findAll({ logging: (sql) => sqlLogs.push(sql) })
  await users.findByEmail(user.email)
  await users.findUserForLogin(user.email)
  await users.update(user.id, { name: 'Logged user' })
  await users.delete(user.id)
  assert.deepEqual(sqlLogs, [])

  const secret = 'plaintext secret embedded in database error'
  const error = new DatabaseError(Object.assign(new Error(secret), { sql: secret }))
  assert.throws(() => users.handleError(error), { message: 'Database operation failed' })
  assert.equal(JSON.stringify(errors).includes(secret), false)
})

test('soft deletion never saves plaintext modified by a destruction hook', async () => {
  const diary = await diaries.create({ title: 'Private', content: 'original secret' })
  const original = await Diary.findByPk(diary.id, { raw: true, logging: false })
  Diary.addHook('beforeDestroy', 'mutate-content', (row) =>
    row.setDataValue('content', 'unsafe plaintext')
  )
  try {
    await diaries.delete(diary.id)
    const stored = await Diary.findByPk(diary.id, { raw: true, paranoid: false, logging: false })
    assert.equal(stored.content, original.content)
    assert.equal(stored.iv, original.iv)
    assert.equal(stored.tag, original.tag)
    assert.ok(stored.deletedAt)
  } finally {
    Diary.removeHook('beforeDestroy', 'mutate-content')
  }
})

test('作用域不匹配时不会删除记录或执行实例删除钩子', async () => {
  const diary = await diaries.create({ title: 'Owner A', content: 'private' })
  const original = await Diary.findByPk(diary.id, { raw: true, logging: false })
  let hookCalls = 0
  Diary.addHook('beforeDestroy', 'scoped-wrong-owner', () => hookCalls++)
  try {
    for (const force of [false, true]) {
      assert.equal(await diaries.deleteByTitle('Owner B', diary.id, force), false)
    }
    assert.equal(hookCalls, 0)
    assert.deepEqual(await Diary.findByPk(diary.id, { raw: true, logging: false }), original)
  } finally {
    Diary.removeHook('beforeDestroy', 'scoped-wrong-owner')
  }
})

test('投影式软硬删除仅加载主键与版本并执行同事务实例钩子，不保存钩子写入的明文', async () => {
  for (const force of [false, true]) {
    const diary = await diaries.create({ title: 'Scoped owner', content: 'original secret' })
    const original = await Diary.findByPk(diary.id, { raw: true, logging: false })
    const hooks = []
    Diary.addHook('beforeDestroy', 'scoped-before-destroy', (row, options) => {
      assert.ok(row instanceof Diary)
      assert.deepEqual(Object.keys(row.dataValues).sort(), ['id', 'version'])
      assert.equal(row.version, original.version)
      hooks.push({ name: 'before', transaction: options.transaction, force: options.force })
      row.setDataValue('content', 'unsafe plaintext')
      row.setDataValue('title', 'Hook changed scope')
      row.setDataValue('version', row.version + 100)
    })
    Diary.addHook('afterDestroy', 'scoped-after-destroy', (row, options) => {
      assert.equal(row.id, diary.id)
      hooks.push({ name: 'after', transaction: options.transaction, force: options.force })
    })
    try {
      assert.equal(await diaries.deleteByTitle('Scoped owner', diary.id, force), true)
      assert.deepEqual(
        hooks.map((hook) => hook.name),
        ['before', 'after']
      )
      assert.ok(hooks[0].transaction)
      assert.equal(hooks[0].transaction, hooks[1].transaction)
      assert.ok(hooks.every((hook) => hook.force === force))
      const stored = await Diary.findByPk(diary.id, {
        raw: true,
        paranoid: false,
        logging: false
      })
      if (force) {
        assert.equal(stored, null)
      } else {
        assert.ok(stored.deletedAt)
        assert.equal(stored.content, original.content)
        assert.equal(stored.title, original.title)
        assert.equal(stored.iv, original.iv)
        assert.equal(stored.tag, original.tag)
        assert.equal(stored.version, original.version)
      }
    } finally {
      Diary.removeHook('beforeDestroy', 'scoped-before-destroy')
      Diary.removeHook('afterDestroy', 'scoped-after-destroy')
    }
  }
})

test('投影式软硬删除检测版本竞态并回滚钩子数据库写入', async () => {
  for (const force of [false, true]) {
    const diary = await diaries.create({ title: 'Scoped owner', content: 'private' })
    const original = await Diary.findByPk(diary.id, { raw: true, logging: false })
    let afterCalls = 0
    let sideEffectId
    Diary.addHook('beforeDestroy', 'scoped-version-race', async (row, options) => {
      await Diary.update(
        { version: row.version + 1 },
        { where: { id: row.id }, transaction: options.transaction, hooks: false, logging: false }
      )
      const sideEffect = await diaries.create({ title: 'Race audit', content: 'temporary' })
      sideEffectId = sideEffect.id
    })
    Diary.addHook('afterDestroy', 'scoped-version-after', () => afterCalls++)
    try {
      await assert.rejects(
        diaries.deleteByTitle('Scoped owner', diary.id, force),
        hasCode('DATA_CONFLICT')
      )
      assert.equal(afterCalls, 0)
      assert.deepEqual(await Diary.findByPk(diary.id, { raw: true, logging: false }), original)
      assert.equal(await diaries.findById(sideEffectId), null)
    } finally {
      Diary.removeHook('beforeDestroy', 'scoped-version-race')
      Diary.removeHook('afterDestroy', 'scoped-version-after')
    }
  }
})

test('投影式软硬删除保留最终 SQL 的父作用域，归属竞态失败并回滚', async () => {
  for (const force of [false, true]) {
    const diary = await diaries.create({ title: 'Owner A', content: 'private' })
    const original = await Diary.findByPk(diary.id, { raw: true, logging: false })
    let afterCalls = 0
    Diary.addHook('beforeDestroy', 'scoped-owner-race', async (row, options) => {
      await Diary.update(
        { title: 'Owner B' },
        { where: { id: row.id }, transaction: options.transaction, hooks: false, logging: false }
      )
    })
    Diary.addHook('afterDestroy', 'scoped-owner-after', () => afterCalls++)
    try {
      await assert.rejects(
        diaries.deleteByTitle('Owner A', diary.id, force),
        hasCode('DATA_CONFLICT')
      )
      assert.equal(afterCalls, 0)
      assert.deepEqual(await Diary.findByPk(diary.id, { raw: true, logging: false }), original)
    } finally {
      Diary.removeHook('beforeDestroy', 'scoped-owner-race')
      Diary.removeHook('afterDestroy', 'scoped-owner-after')
    }
  }
})

test('投影式软硬删除检查影响行数，钩子中的物理删除会作为冲突回滚', async () => {
  for (const force of [false, true]) {
    const diary = await diaries.create({ title: 'Scoped owner', content: 'private' })
    const original = await Diary.findByPk(diary.id, { raw: true, logging: false })
    Diary.addHook('beforeDestroy', 'scoped-delete-race', async (row, options) => {
      await Diary.destroy({
        where: { id: row.id },
        transaction: options.transaction,
        force: true,
        hooks: false,
        logging: false
      })
    })
    try {
      await assert.rejects(
        diaries.deleteByTitle('Scoped owner', diary.id, force),
        hasCode('DATA_CONFLICT')
      )
      assert.deepEqual(await Diary.findByPk(diary.id, { raw: true, logging: false }), original)
    } finally {
      Diary.removeHook('beforeDestroy', 'scoped-delete-race')
    }
  }
})

test('投影式软硬删除在 afterDestroy 失败时回滚记录和钩子副作用', async () => {
  for (const force of [false, true]) {
    const diary = await diaries.create({ title: 'Scoped owner', content: 'private' })
    const original = await Diary.findByPk(diary.id, { raw: true, logging: false })
    let sideEffectId
    Diary.addHook('afterDestroy', 'scoped-after-reject', async (_row, options) => {
      assert.ok(options.transaction)
      const sideEffect = await diaries.create({ title: 'Delete audit', content: 'temporary' })
      sideEffectId = sideEffect.id
      throw new AppError('Deletion blocked.', 'DELETE_BLOCKED')
    })
    try {
      await assert.rejects(
        diaries.deleteByTitle('Scoped owner', diary.id, force),
        hasCode('DELETE_BLOCKED')
      )
      assert.deepEqual(await Diary.findByPk(diary.id, { raw: true, logging: false }), original)
      assert.equal(await diaries.findById(sideEffectId), null)
    } finally {
      Diary.removeHook('afterDestroy', 'scoped-after-reject')
    }
  }
})

test('conditional updates reject concurrent soft and hard deletions', async () => {
  for (const force of [false, true]) {
    const user = await users.create(userInput())
    User.addHook('beforeUpdate', 'delete-during-update', async (row) => {
      await User.destroy({ where: { id: row.id }, force, hooks: false, logging: false })
    })
    try {
      await assert.rejects(
        users.update(user.id, { name: 'Stale update' }),
        hasCode('DATA_CONFLICT')
      )
      const stored = await User.findByPk(user.id, { paranoid: false, logging: false })
      assert.ok(stored)
      assert.equal(stored.name, user.name)
      assert.equal(stored.deletedAt, null)
    } finally {
      User.removeHook('beforeUpdate', 'delete-during-update')
    }
  }
})

test('hard deletion detects a stale version instead of reporting success', async () => {
  const diary = await diaries.create({ title: 'Private', content: 'keep me' })
  Diary.addHook('beforeDestroy', 'version-race', async (row) => {
    await Diary.update(
      { version: row.version + 1 },
      { where: { id: row.id }, hooks: false, logging: false }
    )
  })
  try {
    await assert.rejects(diaries.delete(diary.id, true), hasCode('DATA_CONFLICT'))
    assert.ok(await diaries.findById(diary.id))
  } finally {
    Diary.removeHook('beforeDestroy', 'version-race')
  }
})

test('findAll always returns an array even when runtime plain is true', async () => {
  assert.ok(Array.isArray(await users.findAll({ plain: true })))
  assert.deepEqual(await users.findAll({ plain: true, where: { id: 999999 } }), [])
})

test('new passwords reject UTF-8 truncation and hash-shaped plaintext', async () => {
  const user = await users.create(userInput())
  const bcrypt = require('bcryptjs')
  for (const password of ['中'.repeat(24) + '甲', await bcrypt.hash('abcdefgh', 4)]) {
    await assert.rejects(users.create({ ...userInput(), password }), hasCode('VALIDATION_ERROR'))
    await assert.rejects(users.update(user.id, { password }), hasCode('VALIDATION_ERROR'))
  }
  assert.equal((await users.findById(user.id)).password, user.password)
})

test('email reservation includes soft-deleted rows when explicitly requested', async () => {
  const user = await users.create(userInput())
  await users.delete(user.id)
  assert.equal(await users.findByEmail(user.email), null)
  assert.ok(await users.findByEmail(user.email, { paranoid: false }))
})

test('safe database diagnostics retain SQLite codes but not messages', () => {
  const error = new DatabaseError(
    Object.assign(new Error('secret'), { code: 'SQLITE_BUSY', sql: 'secret' })
  )
  assert.throws(() => users.handleError(error))
  assert.deepEqual(errors.at(-1)[1], {
    model: 'User',
    errorType: 'SequelizeDatabaseError',
    code: 'SQLITE_BUSY'
  })
})

test('automatic create transactions roll back the row and afterCreate hook writes', async () => {
  const input = userInput()
  let createdId
  let sideEffectId
  let hookTransaction
  User.addHook('afterCreate', 'fail-after-create', async (row, options) => {
    createdId = row.id
    hookTransaction = options.transaction
    const sideEffect = await Diary.create(
      { title: 'Creation audit', content: 'temporary audit' },
      { transaction: options.transaction, logging: false }
    )
    sideEffectId = sideEffect.id
    throw new AppError('Creation blocked.', 'CREATE_BLOCKED')
  })
  try {
    await assert.rejects(users.create(input), hasCode('CREATE_BLOCKED'))
    assert.ok(hookTransaction)
    assert.equal(await users.findById(createdId), null)
    assert.equal(await diaries.findById(sideEffectId), null)
  } finally {
    User.removeHook('afterCreate', 'fail-after-create')
  }
})

test('automatic update transactions roll back ciphertext, metadata and hook writes', async () => {
  const diary = await diaries.create({ title: 'Original', content: 'original content' })
  const original = await Diary.findByPk(diary.id, { raw: true, logging: false })
  let sideEffectId
  let hookTransaction
  Diary.addHook('afterUpdate', 'fail-after-update', async (_row, options) => {
    hookTransaction = options.transaction
    // 不显式传参的钩子查询也通过 CLS 加入当前事务
    const sideEffect = await diaries.create({ title: 'Update audit', content: 'temporary audit' })
    sideEffectId = sideEffect.id
    throw new AppError('Update blocked.', 'UPDATE_BLOCKED')
  })
  try {
    await assert.rejects(
      diaries.update(diary.id, { content: 'should be rolled back' }),
      hasCode('UPDATE_BLOCKED')
    )
    assert.ok(hookTransaction)
    assert.deepEqual(await Diary.findByPk(diary.id, { raw: true, logging: false }), original)
    assert.equal(await diaries.findById(sideEffectId), null)
  } finally {
    Diary.removeHook('afterUpdate', 'fail-after-update')
  }
})

test('automatic soft and hard deletions roll back when afterDestroy rejects', async () => {
  for (const force of [false, true]) {
    const diary = await diaries.create({ title: 'Protected', content: 'keep me' })
    let hookTransaction
    Diary.addHook('afterDestroy', 'fail-after-destroy', (_row, options) => {
      hookTransaction = options.transaction
      throw new AppError('Deletion blocked.', 'DELETE_BLOCKED')
    })
    try {
      await assert.rejects(diaries.delete(diary.id, force), hasCode('DELETE_BLOCKED'))
      assert.ok(hookTransaction)
      const restored = await diaries.findById(diary.id)
      assert.equal(restored.content, 'keep me')
      assert.equal(restored.deletedAt, null)
    } finally {
      Diary.removeHook('afterDestroy', 'fail-after-destroy')
    }
  }
})

test('repository transactions commit multi-step writes and reuse nested transactions', async () => {
  let createdId
  await diaries.transaction(async (transaction) => {
    const created = await diaries.create({ title: 'Temporary', content: 'initial' })
    createdId = created.id
    await diaries.transaction(async (nestedTransaction) => {
      assert.equal(nestedTransaction, transaction)
      await diaries.update(created.id, { title: 'Committed' })
    })
    assert.equal((await diaries.findById(createdId)).title, 'Committed')
  })
  assert.equal((await diaries.findById(createdId)).title, 'Committed')
})

test('CLS transactions reuse the caller transaction without committing repository writes', async () => {
  const diary = await diaries.create({ title: 'Original', content: 'before transaction' })
  let createdId
  await assert.rejects(
    sequelize.transaction({ logging: false }, async (transaction) => {
      await diaries.transaction(async (nestedTransaction) => {
        assert.equal(nestedTransaction, transaction)
        const created = await diaries.create({ title: 'Temporary', content: 'temporary' })
        createdId = created.id
        await diaries.update(diary.id, { content: 'inside transaction' })
        await diaries.delete(diary.id)
        assert.equal(await diaries.findById(diary.id), null)
        assert.ok(await diaries.findById(createdId))
      })
      throw new Error('rollback-cls-test')
    }),
    { message: 'rollback-cls-test' }
  )
  assert.equal((await diaries.findById(diary.id)).content, 'before transaction')
  assert.equal(await diaries.findById(createdId), null)
})

test('update validation hooks receive the same transaction as write hooks', async () => {
  const diary = await diaries.create({ title: 'Original', content: 'private' })
  const validationTransactions = []
  let writeTransaction
  Diary.addHook('beforeValidate', 'capture-validation-transaction', (_row, options) => {
    validationTransactions.push(options.transaction)
  })
  Diary.addHook('beforeUpdate', 'capture-update-transaction', (_row, options) => {
    writeTransaction = options.transaction
  })
  try {
    await diaries.update(diary.id, { title: 'Updated' })
    assert.ok(writeTransaction)
    assert.equal(validationTransactions.length, 2)
    assert.ok(validationTransactions.every((transaction) => transaction === writeTransaction))
  } finally {
    Diary.removeHook('beforeValidate', 'capture-validation-transaction')
    Diary.removeHook('beforeUpdate', 'capture-update-transaction')
  }
})

test('explicit transactions cover reads and writes and roll back hook results', async () => {
  const diary = await diaries.create({ title: 'Private', content: 'before transaction' })
  let createdId
  await assert.rejects(
    sequelize.transaction(async (transaction) => {
      const options = { transaction }
      const created = await diaries.create({ title: 'Temporary', content: 'temporary' }, options)
      createdId = created.id
      await diaries.update(diary.id, { content: 'inside transaction' }, options)
      assert.equal((await diaries.findById(diary.id, options)).content, 'inside transaction')
      assert.equal(
        (await diaries.findAll(options)).some((row) => row.id === createdId),
        true
      )
      await diaries.delete(createdId, false, options)
      throw new Error('rollback-test')
    }),
    { message: 'rollback-test' }
  )
  assert.equal((await diaries.findById(diary.id)).content, 'before transaction')
  assert.equal(await diaries.findById(createdId), null)
})
