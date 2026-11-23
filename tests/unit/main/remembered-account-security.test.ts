import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../../../src/main/errors'
import RememberedAccountService, {
  RememberedAccountService as NamedRememberedAccountService,
  type RememberedAccountEncryption
} from '../../../src/main/services/RememberedAccountService'

const electronMocks = vi.hoisted(() => ({
  appAccess: vi.fn<() => void>(),
  safeStorageAccess: vi.fn<() => void>(),
  getPath: vi.fn<(name: string) => string>(),
  available: vi.fn<() => Promise<boolean>>(),
  backend: vi.fn<() => string>(),
  encrypt: vi.fn<(value: string) => Promise<Buffer>>(),
  decrypt: vi.fn<(value: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>>()
}))

vi.mock('electron', () => ({
  get app() {
    electronMocks.appAccess()
    return { getPath: electronMocks.getPath }
  },
  get safeStorage() {
    electronMocks.safeStorageAccess()
    return {
      isAsyncEncryptionAvailable: electronMocks.available,
      encryptStringAsync: electronMocks.encrypt,
      decryptStringAsync: electronMocks.decrypt,
      getSelectedStorageBackend: electronMocks.backend
    }
  }
}))

const EMAIL = 'Saved.Mixed@example.test'
const PASSWORD = 'SyntheticPassword42'
const FILE_NAME = 'remembered-account.v1.json'
const TEMP_ROOT = join(process.cwd(), 'outputs', 'security-test-tmp')
const cancellation = new AppError('合成操作已取消', 'OPERATION_CANCELLED')

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

class MemoryEncryption implements RememberedAccountEncryption {
  available = true
  shouldReEncrypt = false
  readonly entries = new Map<string, string>()
  readonly outputs: Buffer[] = []
  readonly inputs: Buffer[] = []
  isAvailable = vi.fn(async () => this.available)
  encrypt = vi.fn(async (value: string): Promise<Buffer> => {
    // 密文只是随机内存索引，不调用 OS 密钥，也不在磁盘保存映射。
    const ciphertext = randomBytes(32)
    this.entries.set(ciphertext.toString('base64'), value)
    this.outputs.push(ciphertext)
    return ciphertext
  })
  decrypt = vi.fn(async (value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }> => {
    this.inputs.push(value)
    const result = this.entries.get(value.toString('base64'))
    if (result === undefined) throw new Error('合成密文无法解密')
    return { result, shouldReEncrypt: this.shouldReEncrypt }
  })
}

function expectWiped(buffer: Buffer): void {
  expect(buffer.equals(Buffer.alloc(buffer.length))).toBe(true)
}

let directory: string
let target: string
let encryption: MemoryEncryption
let service: RememberedAccountService

beforeEach(async () => {
  expect((await fs.lstat(TEMP_ROOT)).isDirectory()).toBe(true)
  directory = await fs.mkdtemp(join(TEMP_ROOT, 'remembered-account-'))
  target = join(directory, FILE_NAME)
  encryption = new MemoryEncryption()
  service = new RememberedAccountService({ directory: () => directory, encryption })
  electronMocks.getPath.mockReset().mockReturnValue(directory)
  electronMocks.available.mockReset().mockResolvedValue(true)
  electronMocks.backend.mockReset().mockReturnValue('gnome_libsecret')
  electronMocks.encrypt.mockReset().mockImplementation(encryption.encrypt)
  electronMocks.decrypt.mockReset().mockImplementation(encryption.decrypt)
  electronMocks.appAccess.mockClear()
  electronMocks.safeStorageAccess.mockClear()
})

async function writeEncryptedPayload(payload: string): Promise<void> {
  const ciphertext = await encryption.encrypt(payload)
  await fs.writeFile(
    target,
    JSON.stringify({ version: 1, ciphertext: ciphertext.toString('base64') })
  )
  ciphertext.fill(0)
  encryption.encrypt.mockClear()
}

function captureReadBuffers(): Buffer[] {
  const buffers: Buffer[] = []
  const nativeAlloc = Buffer.alloc
  vi.spyOn(Buffer, 'alloc').mockImplementation((size, fill, encoding) => {
    const buffer = nativeAlloc(size, fill, encoding)
    if (size === 16 * 1024 + 1) buffers.push(buffer)
    return buffer
  })
  return buffers
}

describe('记住账号的存储与加密边界', () => {
  it('模块加载与构造不访问 Electron 属性、路径或磁盘', () => {
    const getDirectory = vi.fn(() => directory)
    const stat = vi.spyOn(fs, 'lstat')
    const open = vi.spyOn(fs, 'open')
    const mkdir = vi.spyOn(fs, 'mkdir')
    expect(RememberedAccountService).toBe(NamedRememberedAccountService)
    new RememberedAccountService()
    new RememberedAccountService({ directory: getDirectory, encryption })
    expect(electronMocks.appAccess).not.toHaveBeenCalled()
    expect(electronMocks.safeStorageAccess).not.toHaveBeenCalled()
    expect(electronMocks.getPath).not.toHaveBeenCalled()
    expect(getDirectory).not.toHaveBeenCalled()
    expect(stat).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(mkdir).not.toHaveBeenCalled()
  })

  it('默认适配器只在调用时访问 userData 与异步 safeStorage', async () => {
    const nativeService = new RememberedAccountService({ platform: () => 'win32' })
    await nativeService.remember(EMAIL, PASSWORD)
    expect(await nativeService.getInfo()).toEqual({
      email: EMAIL,
      hasSavedPassword: true,
      encryptionAvailable: true,
      recordStatus: 'saved'
    })
    expect(electronMocks.getPath).toHaveBeenCalledWith('userData')
    expect(electronMocks.available).toHaveBeenCalled()
    expect(electronMocks.encrypt).toHaveBeenCalledWith(
      JSON.stringify({ email: EMAIL, password: PASSWORD })
    )
    expect(electronMocks.decrypt).toHaveBeenCalledOnce()
    expect(electronMocks.backend).not.toHaveBeenCalled()
  })

  it.each(['basic_text', 'unknown', 'future_unconfirmed_backend'])(
    'Linux 拒绝未确认安全的后端 %s',
    async (backend) => {
      electronMocks.backend.mockReturnValue(backend)
      const nativeService = new RememberedAccountService({
        directory: () => directory,
        platform: () => 'linux'
      })
      expect(await nativeService.getInfo()).toEqual({
        email: '',
        hasSavedPassword: false,
        encryptionAvailable: false,
        recordStatus: 'unavailable'
      })
      await expect(nativeService.remember(EMAIL, PASSWORD)).rejects.toMatchObject({
        code: 'REMEMBERED_ACCOUNT_UNAVAILABLE'
      })
      await expect(
        nativeService.useRemembered(
          EMAIL,
          undefined,
          vi.fn(async () => undefined)
        )
      ).rejects.toMatchObject({
        code: 'REMEMBERED_ACCOUNT_UNAVAILABLE'
      })
      expect(electronMocks.encrypt).not.toHaveBeenCalled()
      expect(electronMocks.getPath).not.toHaveBeenCalled()
      expect(await fs.readdir(directory)).toEqual([])
    }
  )

  it.each(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])(
    'Linux 接受已确认安全的后端 %s',
    async (backend) => {
      electronMocks.backend.mockReturnValue(backend)
      const nativeService = new RememberedAccountService({
        directory: () => directory,
        platform: () => 'linux'
      })
      await nativeService.remember(EMAIL, PASSWORD)
      expect((await nativeService.getInfo()).email).toBe(EMAIL)
    }
  )

  it('macOS 默认适配器使用异步接口，不访问 Linux 后端选择器', async () => {
    const nativeService = new RememberedAccountService({
      directory: () => directory,
      platform: () => 'darwin'
    })
    await nativeService.remember(EMAIL, PASSWORD)
    expect(electronMocks.encrypt).toHaveBeenCalledOnce()
    expect(electronMocks.backend).not.toHaveBeenCalled()
  })

  it('没有记录时不创建目录或打开文件', async () => {
    const absentDirectory = join(directory, 'not-created')
    const absentService = new RememberedAccountService({
      directory: () => absentDirectory,
      encryption
    })
    const mkdir = vi.spyOn(fs, 'mkdir')
    const open = vi.spyOn(fs, 'open')
    expect(await absentService.getInfo()).toEqual({
      email: '',
      hasSavedPassword: false,
      encryptionAvailable: true,
      recordStatus: 'none'
    })
    expect(mkdir).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(await fs.readdir(directory)).toEqual([])
  })

  it('保存后只返回邮箱与状态，磁盘严格仅包含版本与规范 Base64 密文', async () => {
    await service.remember(EMAIL, PASSWORD)
    const bytes = await fs.readFile(target)
    const contents = bytes.toString('utf8')
    const record: unknown = JSON.parse(contents)
    expect(record).toHaveProperty('version', 1)
    if (
      typeof record !== 'object' ||
      record === null ||
      !('ciphertext' in record) ||
      typeof record.ciphertext !== 'string'
    ) {
      throw new Error('合成存储格式不正确')
    }
    expect(Object.keys(record).sort()).toEqual(['ciphertext', 'version'])
    expect(Buffer.from(record.ciphertext, 'base64').toString('base64')).toBe(record.ciphertext)
    expect(contents).not.toContain(EMAIL)
    expect(contents).not.toContain(PASSWORD)
    expect(contents).not.toMatch(/email|password|userId/)
    expect(await fs.readdir(directory)).toEqual([FILE_NAME])
    expect(await service.getInfo()).toEqual({
      email: EMAIL,
      hasSavedPassword: true,
      encryptionAvailable: true,
      recordStatus: 'saved'
    })
    encryption.outputs.forEach(expectWiped)
    encryption.inputs.forEach(expectWiped)
    bytes.fill(0)
  })

  it('正确邮箱仅向主进程回调交付密码并返回回调结果', async () => {
    await service.remember(EMAIL, PASSWORD)
    const operation = vi.fn(async (email: string, password: string) => {
      expect(password).toBe(PASSWORD)
      return { email, verified: true }
    })
    expect(await service.useRemembered(EMAIL, undefined, operation)).toEqual({
      email: EMAIL,
      verified: true
    })
    expect(operation).toHaveBeenCalledExactlyOnceWith(EMAIL, PASSWORD)
    encryption.inputs.forEach(expectWiped)
  })

  it.each(['different@example.test', EMAIL.toLowerCase(), ` ${EMAIL}`, 'not-an-email'])(
    '不擅自规范化或匹配错误邮箱 %s',
    async (email) => {
      await service.remember(EMAIL, PASSWORD)
      const operation = vi.fn(async () => '不应执行')
      await expect(service.useRemembered(email, undefined, operation)).rejects.toMatchObject({
        code: 'REMEMBERED_ACCOUNT_MISSING'
      })
      expect(operation).not.toHaveBeenCalled()
    }
  )

  it('没有记录时 useRemembered 返回固定缺失错误', async () => {
    await expect(
      service.useRemembered(
        EMAIL,
        undefined,
        vi.fn(async () => undefined)
      )
    ).rejects.toMatchObject({
      code: 'REMEMBERED_ACCOUNT_MISSING'
    })
    expect(encryption.decrypt).not.toHaveBeenCalled()
  })

  it.each([
    [EMAIL, 'short'],
    [EMAIL, 'a'.repeat(31)],
    [EMAIL, '汉'.repeat(25)],
    ['invalid-email', PASSWORD],
    [`${'a'.repeat(255)}@example.test`, PASSWORD]
  ])('沿用完整 LoginSchema 校验，不保存非法凭据 %#', async (email, password) => {
    await expect(service.remember(email, password)).rejects.toMatchObject({
      code: 'REMEMBERED_ACCOUNT_STORAGE_FAILED'
    })
    expect(encryption.encrypt).not.toHaveBeenCalled()
    expect(await fs.readdir(directory)).toEqual([])
  })

  it.each(['a'.repeat(8), 'a'.repeat(30), '汉'.repeat(24)])(
    '接受 LoginSchema 的合法密码长度及 UTF-8 字节边界 %#',
    async (password) => {
      await service.remember(EMAIL, password)
      expect(
        await service.useRemembered(
          EMAIL,
          undefined,
          async (_email, savedPassword) => savedPassword === password
        )
      ).toBe(true)
    }
  )

  it('加密失效时不泄露保存信息、不写明文，仍允许明确清除', async () => {
    await service.remember(EMAIL, PASSWORD)
    const original = await fs.readFile(target, 'utf8')
    encryption.available = false
    expect(await service.getInfo()).toEqual({
      email: '',
      hasSavedPassword: false,
      encryptionAvailable: false,
      recordStatus: 'unavailable'
    })
    await expect(service.remember(EMAIL, PASSWORD)).rejects.toMatchObject({
      code: 'REMEMBERED_ACCOUNT_UNAVAILABLE'
    })
    const operation = vi.fn(async () => '不应执行')
    await expect(service.useRemembered(EMAIL, undefined, operation)).rejects.toMatchObject({
      code: 'REMEMBERED_ACCOUNT_UNAVAILABLE'
    })
    expect(operation).not.toHaveBeenCalled()
    expect(await fs.readFile(target, 'utf8')).toBe(original)
    await service.clear()
    expect(await fs.readdir(directory)).toEqual([])
  })

  it('加密可用性异常脱敏为 unavailable，不访问存储', async () => {
    encryption.isAvailable.mockRejectedValue(new Error(`合成异常 ${directory} ${PASSWORD}`))
    const directoryProvider = vi.fn(() => directory)
    const unavailableService = new RememberedAccountService({
      directory: directoryProvider,
      encryption
    })
    expect((await unavailableService.getInfo()).recordStatus).toBe('unavailable')
    await expect(unavailableService.remember(EMAIL, PASSWORD)).rejects.toEqual(
      new AppError('系统安全加密暂不可用', 'REMEMBERED_ACCOUNT_UNAVAILABLE')
    )
    expect(directoryProvider).not.toHaveBeenCalled()
  })

  it('未知加密错误不保留路径、秘密、原生异常或伪造的取消码', async () => {
    encryption.encrypt.mockRejectedValue(
      new AppError(`${directory} ${PASSWORD}`, 'OPERATION_CANCELLED')
    )
    await expect(service.remember(EMAIL, PASSWORD)).rejects.toEqual(
      new AppError('无法读写已保存的账号资料', 'REMEMBERED_ACCOUNT_STORAGE_FAILED')
    )
    expect(await fs.readdir(directory)).toEqual([])
  })

  it('超过密文上限的加密结果立即擦除且不发布', async () => {
    const oversized = Buffer.alloc(8 * 1024 + 1, 91)
    encryption.encrypt.mockResolvedValueOnce(oversized)
    await expect(service.remember(EMAIL, PASSWORD)).rejects.toMatchObject({
      code: 'REMEMBERED_ACCOUNT_STORAGE_FAILED'
    })
    expectWiped(oversized)
    expect(await fs.readdir(directory)).toEqual([])
  })

  it('getInfo 不因 shouldReEncrypt 擅自发布或自动登录', async () => {
    await service.remember(EMAIL, PASSWORD)
    encryption.shouldReEncrypt = true
    encryption.encrypt.mockClear()
    const rename = vi.spyOn(fs, 'rename')
    const original = await fs.readFile(target, 'utf8')
    expect((await service.getInfo()).recordStatus).toBe('saved')
    expect(encryption.encrypt).not.toHaveBeenCalled()
    expect(rename).not.toHaveBeenCalled()
    expect(await fs.readFile(target, 'utf8')).toBe(original)
  })
})

describe('损坏记录、文件边界与定向清除', () => {
  it.each([
    ['空文件', ''],
    ['非法 JSON', '{'],
    ['非对象', '[]'],
    ['null', 'null'],
    ['未知版本', JSON.stringify({ version: 2, ciphertext: 'AAAA' })],
    ['额外邮箱', JSON.stringify({ version: 1, ciphertext: 'AAAA', email: EMAIL })],
    ['额外 userId', JSON.stringify({ version: 1, ciphertext: 'AAAA', userId: 71 })],
    ['密文类型错误', JSON.stringify({ version: 1, ciphertext: 42 })],
    ['空密文', JSON.stringify({ version: 1, ciphertext: '' })],
    ['缺少 padding', JSON.stringify({ version: 1, ciphertext: 'Zg' })],
    ['非规范 padding 位', JSON.stringify({ version: 1, ciphertext: 'Zh==' })],
    ['换行', JSON.stringify({ version: 1, ciphertext: 'Zg==\n' })],
    ['URL Base64', JSON.stringify({ version: 1, ciphertext: '____' })],
    ['超长 Base64', JSON.stringify({ version: 1, ciphertext: 'A'.repeat(12000) })]
  ])('严格拒绝损坏的外层记录：%s', async (_label, contents) => {
    await fs.writeFile(target, contents)
    const buffers = captureReadBuffers()
    expect(await service.getInfo()).toEqual({
      email: '',
      hasSavedPassword: false,
      encryptionAvailable: true,
      recordStatus: 'damaged'
    })
    await expect(
      service.useRemembered(
        EMAIL,
        undefined,
        vi.fn(async () => undefined)
      )
    ).rejects.toMatchObject({
      code: 'REMEMBERED_ACCOUNT_DAMAGED'
    })
    expect(encryption.decrypt).not.toHaveBeenCalled()
    buffers.forEach(expectWiped)
  })

  it.each([
    ['非法 JSON', '{'],
    ['裸 userId', JSON.stringify({ userId: 71 })],
    ['额外 userId', JSON.stringify({ email: EMAIL, password: PASSWORD, userId: 71 })],
    ['弱密码', JSON.stringify({ email: EMAIL, password: 'short' })],
    ['超 bcrypt 字节上限', JSON.stringify({ email: EMAIL, password: '汉'.repeat(25) })],
    ['非法邮箱', JSON.stringify({ email: 'invalid', password: PASSWORD })],
    ['过长解密结果', 'X'.repeat(2049)]
  ])('严格拒绝损坏的解密内容：%s', async (_label, payload) => {
    await writeEncryptedPayload(payload)
    expect((await service.getInfo()).recordStatus).toBe('damaged')
    encryption.inputs.forEach(expectWiped)
  })

  it('不可解密的记录返回 damaged，错误内容不外泄且回调不执行', async () => {
    await service.remember(EMAIL, PASSWORD)
    encryption.decrypt.mockRejectedValue(new Error(`${directory} ${PASSWORD}`))
    const buffers = captureReadBuffers()
    expect((await service.getInfo()).recordStatus).toBe('damaged')
    const operation = vi.fn(async () => '不应执行')
    await expect(service.useRemembered(EMAIL, undefined, operation)).rejects.toEqual(
      new AppError('已保存的账号资料损坏', 'REMEMBERED_ACCOUNT_DAMAGED')
    )
    expect(operation).not.toHaveBeenCalled()
    buffers.forEach(expectWiped)
    for (const [input] of encryption.decrypt.mock.calls) expectWiped(input)
  })

  it('巨大文件在 lstat 后直接拒绝，不打开、不解析、不解密', async () => {
    const fixture = await fs.open(target, 'w')
    await fixture.truncate(16 * 1024 + 1)
    await fixture.close()
    const open = vi.spyOn(fs, 'open')
    expect((await service.getInfo()).recordStatus).toBe('damaged')
    expect(open).not.toHaveBeenCalled()
    expect(encryption.decrypt).not.toHaveBeenCalled()
  })

  it('lstat 与 open 之间替换同长度文件仍被文件身份复核拒绝', async () => {
    await service.remember(EMAIL, PASSWORD)
    const replacement = join(directory, 'synthetic-replacement')
    await fs.writeFile(replacement, await fs.readFile(target))
    const nativeOpen = fs.open
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      await fs.rename(replacement, target)
      return nativeOpen(...args)
    })
    expect((await service.getInfo()).recordStatus).toBe('damaged')
    expect(encryption.decrypt).not.toHaveBeenCalled()
  })

  it('文件身份复核后继续增长也只读取固定上限并擦除缓冲区', async () => {
    await service.remember(EMAIL, PASSWORD)
    const buffers = captureReadBuffers()
    const readFile = vi.spyOn(fs, 'readFile')
    const nativeOpen = fs.open
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await nativeOpen(...args)
      const nativeStat = handle.stat.bind(handle)
      vi.spyOn(handle, 'stat').mockImplementationOnce(async (options) => {
        const snapshot = await nativeStat(options)
        await fs.appendFile(target, Buffer.alloc(48 * 1024, 91))
        return snapshot
      })
      return handle
    })
    expect((await service.getInfo()).recordStatus).toBe('damaged')
    expect(readFile).not.toHaveBeenCalled()
    expect(encryption.decrypt).not.toHaveBeenCalled()
    expect(buffers).toHaveLength(1)
    expect(buffers[0].length).toBe(16 * 1024 + 1)
    buffers.forEach(expectWiped)
  })

  it('拒绝目录链接，不读取、覆盖或删除链接指向的内容', async () => {
    const outside = join(directory, 'synthetic-link-destination')
    await fs.mkdir(outside)
    const marker = join(outside, 'keep.txt')
    await fs.writeFile(marker, '合成保留标记')
    await fs.symlink(outside, target, 'junction')
    expect((await service.getInfo()).recordStatus).toBe('damaged')
    await expect(service.remember(EMAIL, PASSWORD)).rejects.toMatchObject({
      code: 'REMEMBERED_ACCOUNT_STORAGE_FAILED'
    })
    await expect(service.clear()).rejects.toMatchObject({
      code: 'REMEMBERED_ACCOUNT_STORAGE_FAILED'
    })
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true)
    expect(await fs.readFile(marker, 'utf8')).toBe('合成保留标记')
    expect(encryption.decrypt).not.toHaveBeenCalled()
  })

  it('拒绝多硬链接的记录，不破坏另一链接', async () => {
    const outside = join(directory, 'synthetic-hardlink')
    await fs.writeFile(outside, '合成保留内容')
    await fs.link(outside, target)
    expect((await service.getInfo()).recordStatus).toBe('damaged')
    await expect(service.remember(EMAIL, PASSWORD)).rejects.toMatchObject({
      code: 'REMEMBERED_ACCOUNT_STORAGE_FAILED'
    })
    await expect(service.clear()).rejects.toMatchObject({
      code: 'REMEMBERED_ACCOUNT_STORAGE_FAILED'
    })
    expect(await fs.readFile(outside, 'utf8')).toBe('合成保留内容')
  })

  it('clear 拒绝普通目录，不递归清空固定目标', async () => {
    await fs.mkdir(target)
    const marker = join(target, 'keep.txt')
    await fs.writeFile(marker, '合成保留标记')
    await expect(service.clear()).rejects.toMatchObject({
      code: 'REMEMBERED_ACCOUNT_STORAGE_FAILED'
    })
    expect(await fs.readFile(marker, 'utf8')).toBe('合成保留标记')
  })

  it('clear 幂等，仅删除固定账号文件而保留其他文件', async () => {
    const unrelated = join(directory, 'unrelated.json')
    await fs.writeFile(unrelated, '{}')
    await service.clear()
    await service.remember(EMAIL, PASSWORD)
    await service.clear()
    await service.clear()
    expect((await service.getInfo()).recordStatus).toBe('none')
    expect(await fs.readdir(directory)).toEqual(['unrelated.json'])
  })

  it('发布失败保留旧记录，只清理自己创建的临时文件', async () => {
    await service.remember(EMAIL, PASSWORD)
    const original = await fs.readFile(target, 'utf8')
    const unrelatedTemporary = `${FILE_NAME}.someone-else.tmp`
    await fs.writeFile(join(directory, unrelatedTemporary), '合成无关临时文件')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error(`${directory} ${PASSWORD}`))
    await expect(service.remember(EMAIL, 'UpdatedPassword42')).rejects.toEqual(
      new AppError('无法读写已保存的账号资料', 'REMEMBERED_ACCOUNT_STORAGE_FAILED')
    )
    expect(await fs.readFile(target, 'utf8')).toBe(original)
    expect((await fs.readdir(directory)).sort()).toEqual([FILE_NAME, unrelatedTemporary].sort())
    encryption.outputs.forEach(expectWiped)
  })

  it('未知 IO 与目录提供器异常只返回脱敏存储错误', async () => {
    vi.spyOn(fs, 'lstat').mockRejectedValueOnce(new Error(`${directory} ${PASSWORD}`))
    await expect(service.getInfo()).rejects.toEqual(
      new AppError('无法读写已保存的账号资料', 'REMEMBERED_ACCOUNT_STORAGE_FAILED')
    )
    const failedDirectoryService = new RememberedAccountService({
      directory: () => {
        throw new Error(`${directory} ${PASSWORD}`)
      },
      encryption
    })
    await expect(failedDirectoryService.clear()).rejects.toEqual(
      new AppError('无法读写已保存的账号资料', 'REMEMBERED_ACCOUNT_STORAGE_FAILED')
    )
  })

  it('读取后加密可用性消失时不解密，不将记录视为可用账号', async () => {
    await service.remember(EMAIL, PASSWORD)
    encryption.isAvailable.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const buffers = captureReadBuffers()
    expect((await service.getInfo()).recordStatus).toBe('unavailable')
    expect(encryption.decrypt).not.toHaveBeenCalled()
    buffers.forEach(expectWiped)
  })
})

describe('异步取消、Buffer 清理与串行协调', () => {
  it('入口 guard 取消不访问加密或磁盘，并保留真实 AppError 对象', async () => {
    const guard = () => {
      throw cancellation
    }
    const operation = vi.fn(async () => '不应执行')
    const stat = vi.spyOn(fs, 'lstat')
    await expect(service.getInfo(guard)).rejects.toBe(cancellation)
    await expect(service.remember(EMAIL, PASSWORD, guard)).rejects.toBe(cancellation)
    await expect(service.useRemembered(EMAIL, guard, operation)).rejects.toBe(cancellation)
    await expect(service.clear(guard)).rejects.toBe(cancellation)
    expect(encryption.isAvailable).not.toHaveBeenCalled()
    expect(stat).not.toHaveBeenCalled()
    expect(operation).not.toHaveBeenCalled()
  })

  it('真实 guard AppError 即使使用记录状态码也不会被转换成状态 DTO', async () => {
    await service.remember(EMAIL, PASSWORD)
    const guardError = new AppError('合成单次 guard 错误', 'REMEMBERED_ACCOUNT_DAMAGED')
    let nextGuardError: AppError | undefined
    encryption.decrypt.mockImplementationOnce(async () => {
      nextGuardError = guardError
      return {
        result: JSON.stringify({ email: EMAIL, password: PASSWORD }),
        shouldReEncrypt: false
      }
    })
    await expect(
      service.getInfo(() => {
        const error = nextGuardError
        nextGuardError = undefined
        if (error) throw error
      })
    ).rejects.toBe(guardError)
  })

  it('损坏记录清理句柄期间取消仍优先返回真实 guard 错误', async () => {
    await writeEncryptedPayload('{')
    let cancelled = false
    const nativeOpen = fs.open
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await nativeOpen(...args)
      const nativeClose = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
        await nativeClose()
        cancelled = true
      })
      return handle
    })
    await expect(
      service.useRemembered(
        EMAIL,
        () => {
          if (cancelled) throw cancellation
        },
        vi.fn(async () => undefined)
      )
    ).rejects.toBe(cancellation)
  })

  it('clear 在 unlink 前的单次 guard 异常不被 IO 错误包装且不删记录', async () => {
    await service.remember(EMAIL, PASSWORD)
    const nativeLstat = fs.lstat
    let armed = false
    let checksAfterStat = 0
    vi.spyOn(fs, 'lstat').mockImplementationOnce(async (...args) => {
      const snapshot = await nativeLstat(...args)
      armed = true
      return snapshot
    })
    await expect(
      service.clear(() => {
        if (armed && ++checksAfterStat === 2) throw cancellation
      })
    ).rejects.toBe(cancellation)
    expect((await service.getInfo()).recordStatus).toBe('saved')
  })

  it('可用性 Promise 完成后复核 guard，不能把取消变成 unavailable', async () => {
    const started = deferred()
    const pending = deferred<boolean>()
    let cancelled = false
    encryption.isAvailable.mockImplementationOnce(() => {
      started.resolve()
      return pending.promise
    })
    const result = service.getInfo(() => {
      if (cancelled) throw cancellation
    })
    const assertion = expect(result).rejects.toBe(cancellation)
    await started.promise
    cancelled = true
    pending.resolve(false)
    await assertion
    expect(await fs.readdir(directory)).toEqual([])
  })

  it('加密期间取消不提前擦除尚未交付的 Buffer，完成后擦除且不写磁盘', async () => {
    const started = deferred()
    const pending = deferred<Buffer>()
    const ciphertext = randomBytes(32)
    const original = Buffer.from(ciphertext)
    let cancelled = false
    encryption.encrypt.mockImplementationOnce(() => {
      started.resolve()
      return pending.promise
    })
    const result = service.remember(EMAIL, PASSWORD, () => {
      if (cancelled) throw cancellation
    })
    const assertion = expect(result).rejects.toBe(cancellation)
    await started.promise
    cancelled = true
    expect(ciphertext.equals(original)).toBe(true)
    pending.resolve(ciphertext)
    await assertion
    expectWiped(ciphertext)
    expect(await fs.readdir(directory)).toEqual([])
    original.fill(0)
  })

  it('解密期间取消不提前擦除原生输入，完成后擦除全部读取 Buffer 且不回调', async () => {
    await service.remember(EMAIL, PASSWORD)
    const started = deferred()
    const pending = deferred<{ result: string; shouldReEncrypt: boolean }>()
    const buffers = captureReadBuffers()
    let input: Buffer | undefined
    let original: Buffer | undefined
    let cancelled = false
    encryption.decrypt.mockImplementationOnce((value) => {
      input = value
      original = Buffer.from(value)
      started.resolve()
      return pending.promise
    })
    const operation = vi.fn(async () => '不应执行')
    const result = service.useRemembered(
      EMAIL,
      () => {
        if (cancelled) throw cancellation
      },
      operation
    )
    const assertion = expect(result).rejects.toBe(cancellation)
    await started.promise
    cancelled = true
    expect(input?.equals(original!)).toBe(true)
    buffers.forEach(expectWiped)
    pending.resolve({
      result: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      shouldReEncrypt: false
    })
    await assertion
    expectWiped(input!)
    buffers.forEach(expectWiped)
    expect(operation).not.toHaveBeenCalled()
    original?.fill(0)
  })

  it('读取缓冲区分配后取消也擦除缓冲区，且不调用解密', async () => {
    await service.remember(EMAIL, PASSWORD)
    let cancelled = false
    let captured: Buffer | undefined
    const nativeAlloc = Buffer.alloc
    vi.spyOn(Buffer, 'alloc').mockImplementation((size, fill, encoding) => {
      const buffer = nativeAlloc(size, fill, encoding)
      if (size === 16 * 1024 + 1) {
        captured = buffer
        cancelled = true
      }
      return buffer
    })
    await expect(
      service.getInfo(() => {
        if (cancelled) throw cancellation
      })
    ).rejects.toBe(cancellation)
    expectWiped(captured!)
    expect(encryption.decrypt).not.toHaveBeenCalled()
  })

  it('文件打开期间取消仍关闭已取得句柄', async () => {
    await service.remember(EMAIL, PASSWORD)
    let cancelled = false
    const nativeOpen = fs.open
    let closed = false
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await nativeOpen(...args)
      const nativeClose = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await nativeClose()
        closed = true
      })
      cancelled = true
      return handle
    })
    await expect(
      service.getInfo(() => {
        if (cancelled) throw cancellation
      })
    ).rejects.toBe(cancellation)
    expect(closed).toBe(true)
  })

  it('写入期间取消等待原生写入完成再擦除 Buffer，且清理自己的临时文件', async () => {
    const started = deferred()
    const pending = deferred()
    const nativeOpen = fs.open
    let writeBuffer: Buffer | undefined
    let cancelled = false
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await nativeOpen(...args)
      const nativeWrite = handle.writeFile.bind(handle)
      vi.spyOn(handle, 'writeFile').mockImplementationOnce(async (data, options) => {
        if (!Buffer.isBuffer(data)) throw new Error('测试预期可擦除的 Buffer')
        writeBuffer = data
        started.resolve()
        await pending.promise
        await nativeWrite(data, options)
      })
      return handle
    })
    const result = service.remember(EMAIL, PASSWORD, () => {
      if (cancelled) throw cancellation
    })
    const assertion = expect(result).rejects.toBe(cancellation)
    await started.promise
    cancelled = true
    expect(writeBuffer?.toString('utf8')).toContain('ciphertext')
    pending.resolve()
    await assertion
    expectWiped(writeBuffer!)
    encryption.outputs.forEach(expectWiped)
    expect(await fs.readdir(directory)).toEqual([])
  })

  it('发布完成后发生取消不声称回滚，仍拒绝返回成功并擦除 Buffer', async () => {
    let cancelled = false
    const nativeRename = fs.rename
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
      await nativeRename(...args)
      cancelled = true
    })
    await expect(
      service.remember(EMAIL, PASSWORD, () => {
        if (cancelled) throw cancellation
      })
    ).rejects.toBe(cancellation)
    expect((await service.getInfo()).recordStatus).toBe('saved')
    expect(await fs.readdir(directory)).toEqual([FILE_NAME])
    encryption.outputs.forEach(expectWiped)
  })

  it('保存进行中排队的 clear 最终删除新记录，不被迟到保存覆盖', async () => {
    await service.remember(EMAIL, PASSWORD)
    const started = deferred()
    const pending = deferred()
    const nativeEncrypt = encryption.encrypt.getMockImplementation()!
    encryption.encrypt.mockImplementationOnce(async (value) => {
      started.resolve()
      await pending.promise
      return nativeEncrypt(value)
    })
    const saving = service.remember(EMAIL, 'UpdatedPassword42')
    await started.promise
    let clearCompleted = false
    const clearing = service.clear().then(() => {
      clearCompleted = true
    })
    expect(clearCompleted).toBe(false)
    pending.resolve()
    await Promise.all([saving, clearing])
    expect(clearCompleted).toBe(true)
    expect((await service.getInfo()).recordStatus).toBe('none')
    expect(await fs.readdir(directory)).toEqual([])
  })

  it('clear 进行中排队的保存最终保留新记录', async () => {
    await service.remember(EMAIL, PASSWORD)
    encryption.encrypt.mockClear()
    const started = deferred()
    const pending = deferred()
    const nativeUnlink = fs.unlink
    vi.spyOn(fs, 'unlink').mockImplementationOnce(async (path) => {
      started.resolve()
      await pending.promise
      return nativeUnlink(path)
    })
    const clearing = service.clear()
    await started.promise
    const saving = service.remember(EMAIL, 'UpdatedPassword42')
    expect(encryption.encrypt).not.toHaveBeenCalled()
    pending.resolve()
    await Promise.all([clearing, saving])
    const operation = vi.fn(
      async (_email: string, password: string) => password === 'UpdatedPassword42'
    )
    expect(await service.useRemembered(EMAIL, undefined, operation)).toBe(true)
  })

  it('取消的排队操作不阻塞后续保存', async () => {
    const guard = () => {
      throw cancellation
    }
    await expect(service.clear(guard)).rejects.toBe(cancellation)
    await service.remember(EMAIL, PASSWORD)
    expect((await service.getInfo()).recordStatus).toBe('saved')
  })

  it('useRemembered 回调内 remember 与 clear 不会持锁死锁', async () => {
    await service.remember(EMAIL, PASSWORD)
    const result = await service.useRemembered(EMAIL, undefined, async () => {
      await service.remember(EMAIL, 'UpdatedPassword42')
      await service.clear()
      return '合成身份验证结果'
    })
    expect(result).toBe('合成身份验证结果')
    expect((await service.getInfo()).recordStatus).toBe('none')
  })

  it('外部身份验证尚未完成时其他 clear 可以完成，回调后仍复核 guard', async () => {
    await service.remember(EMAIL, PASSWORD)
    const started = deferred()
    const pending = deferred<string>()
    let cancelled = false
    const result = service.useRemembered(
      EMAIL,
      () => {
        if (cancelled) throw cancellation
      },
      async () => {
        started.resolve()
        return pending.promise
      }
    )
    const assertion = expect(result).rejects.toBe(cancellation)
    await started.promise
    await service.clear()
    expect((await service.getInfo()).recordStatus).toBe('none')
    cancelled = true
    pending.resolve('合成验证完成')
    await assertion
  })

  it('回调抛出的业务错误交由认证层处理，不误包装为存储错误', async () => {
    await service.remember(EMAIL, PASSWORD)
    const authenticationError = new AppError('合成身份验证失败', 'AUTH_FAILED')
    await expect(
      service.useRemembered(EMAIL, undefined, async () => {
        throw authenticationError
      })
    ).rejects.toBe(authenticationError)
  })
})
