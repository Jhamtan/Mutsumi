import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useUserStore } from '../../../src/renderer/src/store/user'
import type { UserDTO } from '../../../src/common/types'

const user: UserDTO = {
  id: 42,
  name: 'Synthetic User',
  email: 'synthetic@example.test',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('useUserStore', () => {
  it('初始状态未登录', () => {
    const store = useUserStore()
    expect(store.currentUser).toBeNull()
    expect(store.isLoggedIn).toBe(false)
  })

  it('伪造用户缓存不能自动认证，且仅清理旧认证缓存', () => {
    localStorage.setItem('auth:user', JSON.stringify(user))
    localStorage.setItem('unrelated', 'keep')
    const store = useUserStore()
    expect(store.currentUser).toBeNull()
    expect(store.isLoggedIn).toBe(false)
    expect(localStorage.getItem('auth:user')).toBeNull()
    expect(localStorage.getItem('unrelated')).toBe('keep')
  })

  it.each(['{broken', 'null'])('异常旧缓存仍保持未登录：%j', (raw) => {
    localStorage.setItem('auth:user', raw)
    const store = useUserStore()
    expect(store.currentUser).toBeNull()
    expect(store.isLoggedIn).toBe(false)
    expect(localStorage.getItem('auth:user')).toBeNull()
  })

  it('无法清理存储也不恢复身份且可正常退出', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('Storage unavailable', 'SecurityError')
    })
    const store = useUserStore()
    expect(store.currentUser).toBeNull()
    store.setUser(user)
    store.logout()
    expect(store.isLoggedIn).toBe(false)
  })

  it('登录只更新内存，不读取或保存用户和密码', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const store = useUserStore()
    store.setUser(user)
    expect(store.currentUser).toEqual(user)
    expect(store.isLoggedIn).toBe(true)
    expect(getItem).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
  })

  it('重启渲染进程需要重新登录', () => {
    const store = useUserStore()
    store.setUser(user)
    setActivePinia(createPinia())
    const restarted = useUserStore()
    expect(restarted.currentUser).toBeNull()
    expect(restarted.isLoggedIn).toBe(false)
  })

  it('替换用户而不合并前一账号数据', () => {
    const store = useUserStore()
    store.setUser(user)
    const replacement = { ...user, id: 43, email: 'other@example.test' }
    store.setUser(replacement)
    expect(store.currentUser).toEqual(replacement)
    expect(localStorage.getItem('auth:user')).toBeNull()
  })

  it('幂等登出不清理其他存储', () => {
    const store = useUserStore()
    store.setUser(user)
    localStorage.setItem('unrelated', 'keep')
    store.logout()
    store.logout()
    expect(store.currentUser).toBeNull()
    expect(store.isLoggedIn).toBe(false)
    expect(localStorage.getItem('auth:user')).toBeNull()
    expect(localStorage.getItem('unrelated')).toBe('keep')
  })
})
