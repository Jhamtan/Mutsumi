import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import type { PropType } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { FormRules } from 'element-plus'
import type {
  IpcResponse,
  LoginResultDTO,
  RememberedAccountInfoDTO,
  UserDTO
} from '../../../src/common/types'
import { useUserStore } from '../../../src/renderer/src/store/user'
import { useI18nStore } from '../../../src/renderer/src/store/i18n'
import Login from '../../../src/renderer/src/views/Login.vue'

interface LoginModel {
  email: string
  password: string
  rememberAccount: boolean
}
type LoginApi = Pick<
  IAppApi,
  | 'login'
  | 'loginRemembered'
  | 'getRememberedAccount'
  | 'forgetRememberedAccount'
  | 'getCurrentUser'
  | 'logout'
>
let api: { [Key in keyof LoginApi]: Mock<LoginApi[Key]> }
const validate = vi.fn<(valid: boolean) => Promise<boolean>>()
const messages = {
  success: vi.fn<(message: string) => void>(),
  error: vi.fn<(message: string) => void>(),
  warning: vi.fn<(message: string) => void>()
}
const wrappers = new Set<{ unmount(): void }>()
const user: UserDTO = {
  id: 11,
  name: '合成测试用户',
  email: 'saved@example.test',
  createdAt: '2026-11-21T00:00:00.000Z',
  updatedAt: '2026-11-21T00:00:00.000Z'
}
const saved: RememberedAccountInfoDTO = {
  email: user.email,
  hasSavedPassword: true,
  encryptionAvailable: true,
  recordStatus: 'saved'
}
const empty: RememberedAccountInfoDTO = {
  email: '',
  hasSavedPassword: false,
  encryptionAvailable: true,
  recordStatus: 'none'
}
const password = 'Synthetic-password-2026!'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function memoryStorage() {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: vi.fn<Storage['clear']>(() => {
      values.clear()
    }),
    getItem: vi.fn<Storage['getItem']>((key) => values.get(key) ?? null),
    key: vi.fn<Storage['key']>((index) => [...values.keys()][index] ?? null),
    removeItem: vi.fn<Storage['removeItem']>((key) => {
      values.delete(key)
    }),
    setItem: vi.fn<Storage['setItem']>((key, value) => {
      values.set(key, value)
    })
  } satisfies Storage
}
let local: ReturnType<typeof memoryStorage>
let sessionStorageFake: ReturnType<typeof memoryStorage>
function requiresPassword(rules: FormRules): boolean {
  const rulesForPassword = rules.password
  return (Array.isArray(rulesForPassword) ? rulesForPassword : [rulesForPassword]).some(
    (rule) => rule?.required === true
  )
}
const ElFormStub = defineComponent({
  props: {
    model: { type: Object as PropType<LoginModel>, required: true },
    rules: { type: Object as PropType<FormRules>, required: true }
  },
  setup(props, { expose, slots }) {
    expose({
      validate: () =>
        validate(
          props.model.email.includes('@') &&
            (!requiresPassword(props.rules) || props.model.password.length > 0)
        ),
      clearValidate: vi.fn<(field: string) => void>()
    })
    return () => h('form', slots.default?.())
  }
})
const InputStub = defineComponent({
  props: {
    modelValue: { type: String, default: '' },
    disabled: Boolean,
    type: { type: String, default: 'text' }
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () =>
      h('input', {
        value: props.modelValue,
        type: props.type,
        disabled: props.disabled,
        onInput: (event: Event) =>
          emit('update:modelValue', (event.target as HTMLInputElement).value)
      })
  }
})
const CheckboxStub = defineComponent({
  props: { modelValue: Boolean, disabled: Boolean },
  emits: ['update:modelValue', 'change'],
  setup(props, { emit, slots }) {
    return () =>
      h('label', [
        h('input', {
          type: 'checkbox',
          checked: props.modelValue,
          disabled: props.disabled,
          onChange: (event: Event) => {
            const checked = (event.target as HTMLInputElement).checked
            emit('update:modelValue', checked)
            emit('change', checked)
          }
        }),
        slots.default?.()
      ])
  }
})
const FormItemStub = defineComponent({
  setup(_, { slots }) {
    return () => h('div', slots.default?.())
  }
})

async function mountLogin(query: Record<string, string> = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      ...['/home', '/notebooks', '/settings'].map((path) => ({
        path,
        component: FormItemStub,
        meta: { requiresAuth: true }
      })),
      ...['/login', '/register'].map((path) => ({
        path,
        component: FormItemStub,
        meta: { guestOnly: true }
      })),
      { path: '/:pathMatch(.*)*', component: FormItemStub }
    ]
  })
  await router.push({ path: '/login', query })
  await router.isReady()
  const store = useUserStore(pinia)
  // 保持路由宿主存活，单独卸载登录页不能被误当作卸载整个应用。
  const host = mount(FormItemStub, { global: { plugins: [pinia, router] } })
  wrappers.add(host)
  const wrapper = mount(Login, {
    global: {
      plugins: [pinia, router],
      stubs: {
        ElForm: ElFormStub,
        ElFormItem: FormItemStub,
        ElInput: InputStub,
        ElCheckbox: CheckboxStub,
        EmailInput: InputStub
      }
    }
  })
  wrappers.add(wrapper)
  await flushPromises()
  const translations = useI18nStore(pinia).t.login
  return { wrapper, router, store, translations }
}
type LoginPage = Awaited<ReturnType<typeof mountLogin>>
function unmountPage(page: LoginPage) {
  wrappers.delete(page.wrapper)
  page.wrapper.unmount()
}
async function enterPassword(page: LoginPage, value = password) {
  await page.wrapper.get('[data-testid="login-password"]').setValue(value)
}
async function submit(page: LoginPage) {
  await page.wrapper.get('form').trigger('submit')
  await flushPromises()
}
function expectNoStoredCredentials() {
  expect(local.setItem).not.toHaveBeenCalled()
  expect(sessionStorageFake.setItem).not.toHaveBeenCalled()
}

beforeEach(() => {
  validate.mockReset().mockImplementation(async (valid) => valid)
  Object.values(messages).forEach((mock) => mock.mockReset())
  local = memoryStorage()
  sessionStorageFake = memoryStorage()
  vi.stubGlobal('localStorage', local)
  vi.stubGlobal('sessionStorage', sessionStorageFake)
  vi.stubGlobal('ElMessage', messages)
  vi.stubGlobal('safeStorage', {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn(() => {
      throw new Error('渲染层不能加密真实密码')
    }),
    decryptString: vi.fn(() => {
      throw new Error('渲染层不能读取解密密码')
    })
  })
  api = {
    login: vi.fn<LoginApi['login']>().mockResolvedValue({ success: true, data: { ...user } }),
    loginRemembered: vi
      .fn<LoginApi['loginRemembered']>()
      .mockResolvedValue({ success: true, data: { ...user } }),
    getRememberedAccount: vi
      .fn<LoginApi['getRememberedAccount']>()
      .mockResolvedValue({ success: true, data: { ...saved } }),
    forgetRememberedAccount: vi
      .fn<LoginApi['forgetRememberedAccount']>()
      .mockResolvedValue({ success: true, data: null }),
    getCurrentUser: vi
      .fn<LoginApi['getCurrentUser']>()
      .mockResolvedValue({ success: false, code: 'AUTH_REQUIRED' }),
    logout: vi.fn<LoginApi['logout']>().mockResolvedValue({ success: true, data: null })
  }
  vi.stubGlobal('api', api)
})
afterEach(() => {
  wrappers.forEach((wrapper) => wrapper.unmount())
  wrappers.clear()
  vi.unstubAllGlobals()
})

describe('Login 记住账号与登录边界', () => {
  it('保存账号仅回填邮箱和密码占位，不获取密码或自动认证', async () => {
    const page = await mountLogin()
    expect(page.wrapper.get<HTMLInputElement>('[data-testid="login-email"]').element.value).toBe(
      user.email
    )
    const input = page.wrapper.get<HTMLInputElement>('[data-testid="login-password"]')
    expect(input.element.value).toBe('')
    expect(input.attributes('placeholder')).toBe(page.translations.rememberedPlaceholder)
    expect(page.wrapper.find('[data-testid="remembered-password-note"]').exists()).toBe(true)
    expect(requiresPassword(page.wrapper.getComponent(ElFormStub).props('rules'))).toBe(false)
    expect(page.store.isLoggedIn).toBe(false)
    expect(api.login).not.toHaveBeenCalled()
    expect(api.loginRemembered).not.toHaveBeenCalled()
    expect(api.getCurrentUser).not.toHaveBeenCalled()
    expectNoStoredCredentials()
  })

  it('提交保存密码调用 loginRemembered 并设定身份及安全重定向', async () => {
    const page = await mountLogin({ redirect: '/notebooks?unlock=7' })
    await submit(page)
    expect(api.loginRemembered).toHaveBeenCalledExactlyOnceWith(user.email, {
      rememberAccount: true
    })
    expect(api.login).not.toHaveBeenCalled()
    expect(page.store.currentUser).toEqual(user)
    expect(page.store.authenticationPending).toBe(false)
    expect(page.router.currentRoute.value.fullPath).toBe('/notebooks?unlock=7')
    expect(messages.success).toHaveBeenCalledWith(page.translations.loginSuccess)
    expectNoStoredCredentials()
  })

  it.each([
    'https://example.invalid/notebooks',
    '//example.invalid/notebooks',
    '/login',
    '/unknown'
  ])('成功登录拒绝不安全重定向 %s', async (redirect) => {
    const page = await mountLogin({ redirect })
    await submit(page)
    expect(page.store.isLoggedIn).toBe(true)
    expect(page.router.currentRoute.value.fullPath).toBe('/home')
  })

  it('没有保存数据时密码必填并手动登录，不默认提交记住偏好', async () => {
    api.getRememberedAccount.mockResolvedValue({ success: true, data: { ...empty } })
    const page = await mountLogin()
    expect(requiresPassword(page.wrapper.getComponent(ElFormStub).props('rules'))).toBe(true)
    await page.wrapper.get('[data-testid="login-email"]').setValue(user.email)
    await submit(page)
    expect(api.login).not.toHaveBeenCalled()
    await enterPassword(page)
    await submit(page)
    expect(api.login).toHaveBeenCalledExactlyOnceWith(user.email, password, undefined)
    expect(api.loginRemembered).not.toHaveBeenCalled()
    expect(page.store.currentUser).toEqual(user)
    expectNoStoredCredentials()
  })

  it('无保存记录时明确勾选记住邮箱和密码传递偏好', async () => {
    api.getRememberedAccount.mockResolvedValue({ success: true, data: { ...empty } })
    const page = await mountLogin()
    await page.wrapper.get('[data-testid="login-email"]').setValue(user.email)
    await enterPassword(page)
    await page.wrapper.get('[data-testid="remember-account"] input').setValue(true)
    await submit(page)
    expect(api.login).toHaveBeenCalledExactlyOnceWith(user.email, password, {
      rememberAccount: true
    })
    expectNoStoredCredentials()
  })

  it('输入新密码后改走普通 login，密码重新变为必填', async () => {
    const page = await mountLogin()
    await enterPassword(page)
    expect(page.wrapper.find('[data-testid="remembered-password-note"]').exists()).toBe(false)
    expect(requiresPassword(page.wrapper.getComponent(ElFormStub).props('rules'))).toBe(true)
    await submit(page)
    expect(api.login).toHaveBeenCalledExactlyOnceWith(user.email, password, {
      rememberAccount: true
    })
    expect(api.loginRemembered).not.toHaveBeenCalled()
    expect(page.wrapper.get<HTMLInputElement>('[data-testid="login-password"]').element.value).toBe(
      ''
    )
    expectNoStoredCredentials()
  })

  it('注册 query.email 不同不能借用另一账号保存的密码', async () => {
    const otherEmail = 'registered@example.test'
    api.login.mockResolvedValue({ success: true, data: { ...user, email: otherEmail } })
    const page = await mountLogin({ email: otherEmail })
    expect(page.wrapper.get<HTMLInputElement>('[data-testid="login-email"]').element.value).toBe(
      otherEmail
    )
    expect(page.wrapper.find('[data-testid="remembered-password-note"]').exists()).toBe(false)
    expect(requiresPassword(page.wrapper.getComponent(ElFormStub).props('rules'))).toBe(true)
    await submit(page)
    expect(api.loginRemembered).not.toHaveBeenCalled()
    expect(api.login).not.toHaveBeenCalled()
    await enterPassword(page)
    await submit(page)
    expect(api.login).toHaveBeenCalledExactlyOnceWith(otherEmail, password, {
      rememberAccount: true
    })
    expect(page.store.currentUser?.email).toBe(otherEmail)
  })

  it.each(['取消勾选', '忘记账号'] as const)(
    '%s立即清除保存记录，后续只能手动登录且不写浏览器存储',
    async (action) => {
      const page = await mountLogin()
      if (action === '取消勾选')
        await page.wrapper.get('[data-testid="remember-account"] input').setValue(false)
      else await page.wrapper.get('[data-testid="forget-account"]').trigger('click')
      await flushPromises()
      expect(api.forgetRememberedAccount).toHaveBeenCalledExactlyOnceWith()
      expect(page.wrapper.find('[data-testid="remembered-password-note"]').exists()).toBe(false)
      expect(page.wrapper.find('[data-testid="forget-account"]').exists()).toBe(false)
      expect(requiresPassword(page.wrapper.getComponent(ElFormStub).props('rules'))).toBe(true)
      await enterPassword(page)
      await submit(page)
      expect(api.login).toHaveBeenCalledExactlyOnceWith(user.email, password, {
        rememberAccount: false
      })
      expect(api.loginRemembered).not.toHaveBeenCalled()
      expectNoStoredCredentials()
    }
  )

  it('系统加密不可用仍可输入密码手动登录', async () => {
    api.getRememberedAccount.mockResolvedValue({
      success: true,
      data: { ...empty, encryptionAvailable: false, recordStatus: 'unavailable' }
    })
    const page = await mountLogin()
    expect(
      page.wrapper.get<HTMLInputElement>('[data-testid="remember-account"] input').element.disabled
    ).toBe(true)
    expect(page.wrapper.text()).toContain(page.translations.rememberUnavailable)
    await page.wrapper.get('[data-testid="login-email"]').setValue(user.email)
    await enterPassword(page)
    await submit(page)
    expect(api.login).toHaveBeenCalledExactlyOnceWith(user.email, password, undefined)
    expect(page.store.isLoggedIn).toBe(true)
    expect(api.loginRemembered).not.toHaveBeenCalled()
  })

  it.each(['storage-failed', 'unavailable'] as const)(
    '记住项保存失败 %s 仅 warning，不伪装登录失败',
    async (error) => {
      api.loginRemembered.mockResolvedValue({
        success: true,
        data: { ...user, rememberedAccount: { saved: false, error } }
      })
      const page = await mountLogin()
      await submit(page)
      expect(page.store.currentUser).toEqual(user)
      expect(page.router.currentRoute.value.path).toBe('/home')
      expect(messages.warning).toHaveBeenCalledExactlyOnceWith(page.translations.rememberSaveFail)
      expect(messages.success).toHaveBeenCalledWith(page.translations.loginSuccess)
      expect(messages.error).not.toHaveBeenCalled()
      expect(api.logout).not.toHaveBeenCalled()
      expectNoStoredCredentials()
    }
  )

  it('验证等待期间重复提交不能启动第二次验证或登录请求', async () => {
    const validation = deferred<boolean>()
    const login = deferred<IpcResponse<LoginResultDTO>>()
    validate.mockImplementation(() => validation.promise)
    api.loginRemembered.mockReturnValue(login.promise)
    const page = await mountLogin()
    await page.wrapper.get('form').trigger('submit')
    await page.wrapper.get('form').trigger('submit')
    expect(validate).toHaveBeenCalledTimes(1)
    expect(api.loginRemembered).not.toHaveBeenCalled()
    expect(
      page.wrapper.get<HTMLButtonElement>('[data-testid="login-submit"]').element.disabled
    ).toBe(true)
    validation.resolve(true)
    await flushPromises()
    await page.wrapper.get('form').trigger('submit')
    expect(api.loginRemembered).toHaveBeenCalledTimes(1)
    login.resolve({ success: true, data: { ...user } })
    await flushPromises()
    expect(page.store.currentUser).toEqual(user)
  })

  it.each(['卸载', '新身份'] as const)('验证等待期间%s后不能发起旧登录', async (change) => {
    const validation = deferred<boolean>()
    validate.mockImplementation(() => validation.promise)
    const page = await mountLogin()
    await page.wrapper.get('form').trigger('submit')
    if (change === '卸载') unmountPage(page)
    else page.store.setUser({ ...user, id: 12 })
    validation.resolve(true)
    await flushPromises()
    expect(api.login).not.toHaveBeenCalled()
    expect(api.loginRemembered).not.toHaveBeenCalled()
    expect(api.logout).not.toHaveBeenCalled()
    expect(page.store.currentUser?.id ?? null).toBe(change === '新身份' ? 12 : null)
    expect(page.router.currentRoute.value.path).toBe('/login')
  })

  it('卸载当前登录实例会取消自身尝试，迟到成功不能恢复身份或导航', async () => {
    const pending = deferred<IpcResponse<LoginResultDTO>>()
    api.loginRemembered.mockReturnValue(pending.promise)
    const page = await mountLogin()
    await submit(page)
    expect(page.store.authenticationPending).toBe(true)
    unmountPage(page)
    expect(api.logout).toHaveBeenCalledTimes(1)
    pending.resolve({ success: true, data: { ...user } })
    await flushPromises()
    expect(page.store.isLoggedIn).toBe(false)
    expect(page.store.authenticationPending).toBe(false)
    expect(page.router.currentRoute.value.path).toBe('/login')
    expect(messages.success).not.toHaveBeenCalled()
  })

  it.each([
    { change: '旧实例保留', sameAccount: false },
    { change: '卸载旧实例', sameAccount: false },
    { change: '旧实例保留', sameAccount: true },
    { change: '卸载旧实例', sameAccount: true }
  ])(
    '新登录完成后 $change（同账号=$sameAccount），旧成功不能覆盖身份、导航或发 logout',
    async ({ change, sameAccount }) => {
      const pending = deferred<IpcResponse<LoginResultDTO>>()
      api.loginRemembered.mockReturnValue(pending.promise)
      const page = await mountLogin()
      await submit(page)
      const newUser = {
        ...user,
        id: sameAccount ? user.id : 12,
        email: sameAccount ? user.email : 'new@example.test',
        name: '新代际身份'
      }
      const attempt = page.store.beginAuthentication()
      expect(page.store.completeAuthentication(newUser, attempt)).toBe(true)
      await page.router.replace('/settings')
      if (change === '卸载旧实例') unmountPage(page)
      pending.resolve({ success: true, data: { ...user } })
      await flushPromises()
      expect(page.store.currentUser).toEqual(newUser)
      expect(page.router.currentRoute.value.path).toBe('/settings')
      expect(api.logout).not.toHaveBeenCalled()
      expect(messages.success).not.toHaveBeenCalled()
      expect(messages.error).not.toHaveBeenCalled()
    }
  )

  it('同账号新代际也忽略旧登录失败和拒绝，不退出新身份', async () => {
    const pending = deferred<IpcResponse<LoginResultDTO>>()
    api.loginRemembered.mockReturnValue(pending.promise)
    const page = await mountLogin()
    await submit(page)
    page.store.setUser({ ...user, name: '同账号新会话' })
    await page.router.replace('/settings')
    pending.reject(new Error('旧登录请求失败'))
    await flushPromises()
    expect(page.store.currentUser?.name).toBe('同账号新会话')
    expect(page.router.currentRoute.value.path).toBe('/settings')
    expect(api.logout).not.toHaveBeenCalled()
    expect(messages.error).not.toHaveBeenCalled()
  })

  it.each([
    { success: false, code: 'AUTH_FAILED' },
    { success: true },
    { success: true, data: { ...user, id: 0 } }
  ] satisfies IpcResponse<LoginResultDTO>[])(
    '坏保存登录结果 %j 要求重新输入，不能当作已登录',
    async (response) => {
      api.loginRemembered.mockResolvedValue(response)
      const page = await mountLogin()
      await submit(page)
      expect(page.store.isLoggedIn).toBe(false)
      expect(page.router.currentRoute.value.path).toBe('/login')
      expect(page.wrapper.find('[data-testid="remembered-password-note"]').exists()).toBe(false)
      expect(requiresPassword(page.wrapper.getComponent(ElFormStub).props('rules'))).toBe(true)
      expect(messages.error).toHaveBeenCalledWith(page.translations.rememberedLoginFail)
      expect(messages.success).not.toHaveBeenCalled()
      await submit(page)
      expect(api.loginRemembered).toHaveBeenCalledTimes(1)
      expect(api.login).not.toHaveBeenCalled()
      await enterPassword(page)
      await submit(page)
      expect(api.login).toHaveBeenCalledExactlyOnceWith(user.email, password, {
        rememberAccount: true
      })
      expect(page.store.isLoggedIn).toBe(true)
    }
  )

  it('迟到保存偏好不能覆盖已经建立的新身份或正在输入的密码', async () => {
    const pending = deferred<IpcResponse<RememberedAccountInfoDTO>>()
    api.getRememberedAccount.mockReturnValue(pending.promise)
    const page = await mountLogin()
    await page.wrapper.get('[data-testid="login-email"]').setValue('typed@example.test')
    await enterPassword(page)
    page.store.setUser({ ...user, id: 12 })
    pending.resolve({ success: true, data: { ...saved } })
    await flushPromises()
    expect(page.wrapper.get<HTMLInputElement>('[data-testid="login-email"]').element.value).toBe(
      'typed@example.test'
    )
    expect(page.wrapper.get<HTMLInputElement>('[data-testid="login-password"]').element.value).toBe(
      password
    )
    expect(page.wrapper.find('[data-testid="remembered-password-note"]').exists()).toBe(false)
    expect(page.store.currentUser?.id).toBe(12)
    expect(api.logout).not.toHaveBeenCalled()
    expectNoStoredCredentials()
  })
})
