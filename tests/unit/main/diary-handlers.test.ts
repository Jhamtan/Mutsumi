import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcResponse } from '../../../src/common/types'
import type { NotebookSummaryDTO } from '../../../src/common/diary'
import { createIpcEvent } from '../helpers/ipc-event'
import { setSession, unlockNotebook } from '../../../src/main/ipc/security'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  fromWebContents: vi.fn(),
  showSaveDialog: vi.fn(),
  showOpenDialog: vi.fn(),
  notebookCreate: vi.fn(),
  notebookList: vi.fn(),
  notebookUnlock: vi.fn(),
  diaryList: vi.fn(),
  diaryListPage: vi.fn(),
  diaryGet: vi.fn(),
  diaryCreate: vi.fn(),
  diaryUpdate: vi.fn(),
  diaryDelete: vi.fn(),
  exportBackup: vi.fn(),
  importBackup: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.handle },
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  dialog: {
    showSaveDialog: mocks.showSaveDialog,
    showOpenDialog: mocks.showOpenDialog
  }
}))
vi.mock('../../../src/main/logger', () => ({ default: { error: vi.fn() } }))
vi.mock('../../../src/main/services/NotebookService', () => ({
  default: class {
    create = mocks.notebookCreate
    list = mocks.notebookList
    unlock = mocks.notebookUnlock
  }
}))
vi.mock('../../../src/main/services/DiaryService', () => ({
  default: class {
    list = mocks.diaryList
    listPage = mocks.diaryListPage
    get = mocks.diaryGet
    create = mocks.diaryCreate
    update = mocks.diaryUpdate
    delete = mocks.diaryDelete
  }
}))
vi.mock('../../../src/main/services/DiaryBackupService', () => ({
  default: class {
    exportBackup = mocks.exportBackup
    importBackup = mocks.importBackup
  }
}))

import { registerNotebookHandlers } from '../../../src/main/ipc/handlers/notebook-handlers'
import { registerDiaryHandlers } from '../../../src/main/ipc/handlers/diary-handlers'
import { registerBackupHandlers } from '../../../src/main/ipc/handlers/backup-handlers'

/**
 * Tests notebook/diary/backup IPC handlers: channel registration, session and
 * unlock gating, dialog flow, and redaction of service failures.
 */
type Handler = (event: IpcMainInvokeEvent, args: unknown) => Promise<IpcResponse<unknown>>
const handlers = new Map<string, Handler>()
const notebook: NotebookSummaryDTO = {
  id: 7,
  uuid: '51b0554e-868e-45bf-aa2d-bdf74ed6436f',
  name: 'Journal',
  createdAt: '2026-10-28T00:00:00.000Z',
  updatedAt: '2026-10-28T00:00:00.000Z'
}
const key = Buffer.alloc(32, 3)

beforeEach(() => {
  vi.resetAllMocks()
  handlers.clear()
  mocks.handle.mockImplementation((channel: string, handler: Handler) =>
    handlers.set(channel, handler)
  )
  mocks.fromWebContents.mockReturnValue(null)
  registerNotebookHandlers()
  registerDiaryHandlers()
  registerBackupHandlers()
})

function invoke(channel: string, event: IpcMainInvokeEvent, args: unknown = undefined) {
  return handlers.get(channel)!(event, args)
}

// Helpers prime the per-window session and notebook key before invoking a handler.
function authenticatedEvent(userId = 42) {
  const source = createIpcEvent()
  setSession(source.event, userId)
  return source
}

function unlockedEvent(userId = 42) {
  const source = authenticatedEvent(userId)
  unlockNotebook(source.event, notebook.id, key)
  return source
}

describe('notebook handlers', () => {
  it('registers public notebook, diary and backup channels', () => {
    expect([...handlers.keys()]).toEqual([
      'notebook:create',
      'notebook:list',
      'notebook:unlock',
      'notebook:lock',
      'diary:list',
      'diary:get',
      'diary:create',
      'diary:update',
      'diary:delete',
      'diary:list-page',
      'diary:backup-export',
      'diary:backup-import'
    ])
  })

  it('uses the main-process session identity when creating a notebook', async () => {
    const source = authenticatedEvent(42)
    mocks.notebookCreate.mockResolvedValue({ dto: notebook, dataKey: Buffer.from(key) })

    expect(
      await invoke('notebook:create', source.event, {
        name: notebook.name,
        password: 'notebook-password'
      })
    ).toEqual({ success: true, data: notebook })
    expect(mocks.notebookCreate).toHaveBeenCalledExactlyOnceWith(
      42,
      notebook.name,
      'notebook-password',
      expect.any(Function)
    )
    mocks.diaryList.mockResolvedValue([])
    expect(await invoke('diary:list', source.event, { notebookId: notebook.id })).toEqual({
      success: true,
      data: []
    })
  })

  it('requires authentication and rejects renderer-supplied identity', async () => {
    const unauthenticated = createIpcEvent().event
    expect((await invoke('notebook:list', unauthenticated)).code).toBe('AUTH_REQUIRED')
    expect(mocks.notebookList).not.toHaveBeenCalled()

    const source = authenticatedEvent()
    expect(
      (
        await invoke('notebook:create', source.event, {
          name: notebook.name,
          password: 'notebook-password',
          userId: 999
        })
      ).code
    ).toBe('INVALID_INPUT')
    expect(mocks.notebookCreate).not.toHaveBeenCalled()
  })

  it('rejects untrusted senders before service access', async () => {
    expect((await invoke('notebook:list', createIpcEvent(undefined, false).event)).code).toBe(
      'IPC_FORBIDDEN'
    )
    expect(mocks.notebookList).not.toHaveBeenCalled()
  })
})

describe('diary handlers', () => {
  it('分页接口在未登录或未解锁时不访问服务', async () => {
    expect(
      (await invoke('diary:list-page', createIpcEvent().event, { notebookId: notebook.id })).code
    ).toBe('AUTH_REQUIRED')
    expect(
      (await invoke('diary:list-page', authenticatedEvent().event, { notebookId: notebook.id }))
        .code
    ).toBe('NOTEBOOK_LOCKED')
    expect(mocks.diaryListPage).not.toHaveBeenCalled()
  })

  it('分页接口使用默认页码和20条，并传递固定会话身份、临时密钥和守卫', async () => {
    const source = unlockedEvent(42)
    const page = { items: [], total: 0, page: 1, pageSize: 20 }
    mocks.diaryListPage.mockResolvedValue(page)
    expect(await invoke('diary:list-page', source.event, { notebookId: notebook.id })).toEqual({
      success: true,
      data: page
    })
    expect(mocks.diaryListPage).toHaveBeenCalledExactlyOnceWith(
      42,
      notebook.id,
      Buffer.alloc(32),
      { page: 1, pageSize: 20 },
      expect.any(Function)
    )
    expect(mocks.diaryListPage.mock.calls[0][2]).not.toBe(key)
    expect(mocks.diaryList).not.toHaveBeenCalled()
  })

  it('分页接口接受最大100条及指定页码', async () => {
    const source = unlockedEvent()
    const page = { items: [], total: 0, page: 1, pageSize: 100 }
    mocks.diaryListPage.mockResolvedValue(page)
    expect(
      await invoke('diary:list-page', source.event, {
        notebookId: notebook.id,
        page: 8,
        pageSize: 100
      })
    ).toEqual({ success: true, data: page })
    expect(mocks.diaryListPage.mock.calls[0][3]).toEqual({ page: 8, pageSize: 100 })
  })

  it.each([
    { userId: 999 },
    { page: 0 },
    { page: 1.5 },
    { page: NaN },
    { page: Number.MAX_SAFE_INTEGER },
    { pageSize: 0 },
    { pageSize: 101 },
    { pageSize: 1.5 },
    { pageSize: NaN },
    { pageSize: '20' },
    { extra: 'x'.repeat(5 * 1024) }
  ])('分页接口严格拒绝非法或额外字段 %j', async (options) => {
    const source = unlockedEvent()
    const response = await invoke('diary:list-page', source.event, {
      notebookId: notebook.id,
      ...options
    })
    expect(response).toMatchObject({ success: false, code: 'INVALID_INPUT' })
    expect(mocks.diaryListPage).not.toHaveBeenCalled()
  })

  it('requires a per-window notebook unlock before service access', async () => {
    const source = authenticatedEvent()
    expect((await invoke('diary:list', source.event, { notebookId: notebook.id })).code).toBe(
      'NOTEBOOK_LOCKED'
    )
    expect(mocks.diaryList).not.toHaveBeenCalled()
  })

  it('passes session identity and the in-memory key to diary services', async () => {
    const source = unlockedEvent(42)
    mocks.diaryList.mockResolvedValue([])
    expect(await invoke('diary:list', source.event, { notebookId: notebook.id })).toEqual({
      success: true,
      data: []
    })
    expect(mocks.diaryList).toHaveBeenCalledTimes(1)
    expect(mocks.diaryList.mock.calls[0][0]).toBe(42)
    expect(mocks.diaryList.mock.calls[0][1]).toBe(notebook.id)
    // The operation-owned key is scrubbed before the IPC response resolves.
    expect(mocks.diaryList.mock.calls[0][2]).toEqual(Buffer.alloc(32))
    expect(mocks.diaryList.mock.calls[0][2]).not.toBe(key)
    expect(mocks.diaryList.mock.calls[0][3]).toEqual(expect.any(Function))
  })
})

describe('backup handlers', () => {
  it('does not show export or import dialogs before authentication and unlock checks', async () => {
    const unauthenticated = createIpcEvent().event
    expect(
      (
        await invoke('diary:backup-export', unauthenticated, {
          notebookId: notebook.id
        })
      ).code
    ).toBe('AUTH_REQUIRED')
    expect(
      (await invoke('diary:backup-import', unauthenticated, { password: 'notebook-password' })).code
    ).toBe('AUTH_REQUIRED')
    expect(mocks.showSaveDialog).not.toHaveBeenCalled()
    expect(mocks.showOpenDialog).not.toHaveBeenCalled()

    const locked = authenticatedEvent().event
    expect((await invoke('diary:backup-export', locked, { notebookId: notebook.id })).code).toBe(
      'NOTEBOOK_LOCKED'
    )
    expect(mocks.showSaveDialog).not.toHaveBeenCalled()
  })

  it('returns explicit cancellation without accessing backup services', async () => {
    const source = unlockedEvent()
    mocks.showSaveDialog.mockResolvedValue({ canceled: true })
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })

    expect(await invoke('diary:backup-export', source.event, { notebookId: notebook.id })).toEqual({
      success: true,
      data: { canceled: true }
    })
    expect(
      await invoke('diary:backup-import', source.event, { password: 'notebook-password' })
    ).toEqual({ success: true, data: { canceled: true } })
    expect(mocks.exportBackup).not.toHaveBeenCalled()
    expect(mocks.importBackup).not.toHaveBeenCalled()
  })

  it('uses main-process dialog paths and session identity for export and import', async () => {
    const source = unlockedEvent(42)
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: 'selected.zip' })
    mocks.exportBackup.mockResolvedValue({ canceled: false, diaryCount: 1 })
    expect(
      await invoke('diary:backup-export', source.event, {
        notebookId: notebook.id,
        diaryIds: [2]
      })
    ).toEqual({ success: true, data: { canceled: false, diaryCount: 1 } })
    expect(mocks.exportBackup).toHaveBeenCalledTimes(1)
    expect(mocks.exportBackup.mock.calls[0].slice(0, 3)).toEqual([42, notebook.id, [2]])
    expect(mocks.exportBackup.mock.calls[0][3]).toEqual(Buffer.alloc(32))
    expect(mocks.exportBackup.mock.calls[0][5]).toEqual(expect.any(Function))
    expect(mocks.exportBackup.mock.calls[0][4]).toBe('selected.zip')

    const importedKey = Buffer.alloc(32, 9)
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['selected.zip'] })
    mocks.importBackup.mockResolvedValue({
      result: { canceled: false, notebook, diaryCount: 1 },
      dataKey: importedKey
    })
    expect(
      await invoke('diary:backup-import', source.event, { password: 'notebook-password' })
    ).toEqual({
      success: true,
      data: { canceled: false, notebook, diaryCount: 1 }
    })
    expect(mocks.importBackup).toHaveBeenCalledExactlyOnceWith(
      42,
      'notebook-password',
      'selected.zip',
      expect.any(Function)
    )
    // The handler zeroes the returned data key after responding so it isn't left in memory.
    expect(importedKey.equals(Buffer.alloc(32))).toBe(true)
  })

  it('normalizes unexpected service failures without leaking details', async () => {
    const source = unlockedEvent()
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: 'selected.zip' })
    mocks.exportBackup.mockRejectedValue(new Error('private filesystem path and plaintext'))
    const response = await invoke('diary:backup-export', source.event, {
      notebookId: notebook.id
    })
    expect(response).toMatchObject({ success: false, code: 'INTERNAL_ERROR' })
    expect(JSON.stringify(response)).not.toContain('private')
  })
})
