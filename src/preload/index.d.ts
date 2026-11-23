/**
 * Type declarations for the preload bridge (`window.api` and `window.electron`).
 *
 * Every `api` method resolves to an IpcResponse envelope; payload shapes mirror
 * the DTOs in src/common and are serialized over IPC as JSON.
 */
import {
  IpcResponse,
  UserDTO,
  LoginOptionsDTO,
  LoginResultDTO,
  RememberedAccountInfoDTO,
  CreateUserDTO,
  NotebookSummaryDTO,
  CreateNotebookDTO,
  UnlockNotebookDTO,
  DiarySummaryDTO,
  DiaryPageOptionsDTO,
  DiaryPageDTO,
  DiaryDTO,
  CreateDiaryDTO,
  UpdateDiaryDTO,
  ExportDiaryBackupDTO,
  ImportDiaryBackupDTO,
  BackupExportResultDTO,
  BackupImportResultDTO,
  ItineraryDTO,
  ItinerarySummaryDTO,
  CreateItineraryDTO,
  UpdateItineraryDTO,
  PhotoWallStateDTO,
  PhotoWallPhotoDTO,
  PhotoWallPhotoPageOptionsDTO,
  PhotoWallPhotoPageDTO,
  PhotoWallLimitsDTO,
  PhotoWallUsageDTO,
  AddPhotosResultDTO,
  PhotoWallExportResultDTO,
  CloseBehaviorDTO,
  ResolveCloseDTO,
  CloseAction
} from '@common/types'

declare global {
  interface IAppApi {
    // Key point: return values must be wrapped in Promise<IpcResponse<T>>.
    // Create user: returns a single UserDTO
    createUser: (data: CreateUserDTO) => Promise<IpcResponse<UserDTO>>
    // Login: returns a single UserDTO
    login: (
      email: string,
      pass: string,
      options?: LoginOptionsDTO
    ) => Promise<IpcResponse<LoginResultDTO>>
    logout: () => Promise<IpcResponse<null>>
    getCurrentUser: () => Promise<IpcResponse<UserDTO>>
    getRememberedAccount: () => Promise<IpcResponse<RememberedAccountInfoDTO>>
    loginRemembered: (
      email: string,
      options?: LoginOptionsDTO
    ) => Promise<IpcResponse<LoginResultDTO>>
    forgetRememberedAccount: () => Promise<IpcResponse<null>>
    createNotebook: (data: CreateNotebookDTO) => Promise<IpcResponse<NotebookSummaryDTO>>
    listNotebooks: () => Promise<IpcResponse<NotebookSummaryDTO[]>>
    unlockNotebook: (data: UnlockNotebookDTO) => Promise<IpcResponse<NotebookSummaryDTO>>
    lockNotebook: (notebookId: number) => Promise<IpcResponse<null>>
    listDiaries: (notebookId: number) => Promise<IpcResponse<DiarySummaryDTO[]>>
    listDiaryPage: (
      notebookId: number,
      options?: DiaryPageOptionsDTO
    ) => Promise<IpcResponse<DiaryPageDTO>>
    getDiary: (notebookId: number, diaryId: number) => Promise<IpcResponse<DiaryDTO>>
    createDiary: (data: CreateDiaryDTO) => Promise<IpcResponse<DiaryDTO>>
    updateDiary: (data: UpdateDiaryDTO) => Promise<IpcResponse<DiaryDTO>>
    deleteDiary: (notebookId: number, diaryId: number) => Promise<IpcResponse<boolean>>
    listItineraries: () => Promise<IpcResponse<ItinerarySummaryDTO[]>>
    listAbandonedItineraries: () => Promise<IpcResponse<ItinerarySummaryDTO[]>>
    getItinerary: (itineraryId: number) => Promise<IpcResponse<ItineraryDTO>>
    createItinerary: (data: CreateItineraryDTO) => Promise<IpcResponse<ItineraryDTO>>
    updateItinerary: (data: UpdateItineraryDTO) => Promise<IpcResponse<ItineraryDTO>>
    deleteItinerary: (itineraryId: number) => Promise<IpcResponse<boolean>>
    restoreItinerary: (itineraryId: number) => Promise<IpcResponse<boolean>>
    purgeItinerary: (itineraryId: number) => Promise<IpcResponse<boolean>>
    getPhotoWall: () => Promise<IpcResponse<PhotoWallStateDTO>>
    listPhotoWallPhotos: () => Promise<IpcResponse<PhotoWallPhotoDTO[]>>
    listPhotoWallPhotoPage: (
      options?: PhotoWallPhotoPageOptionsDTO
    ) => Promise<IpcResponse<PhotoWallPhotoPageDTO>>
    getPhotoWallLimits: () => Promise<IpcResponse<PhotoWallUsageDTO>>
    setPhotoWallLimits: (limits: PhotoWallLimitsDTO) => Promise<IpcResponse<PhotoWallUsageDTO>>
    setPhotoWallMinImages: (minImages: number) => Promise<IpcResponse<number>>
    addPhotoWallPhotos: (dataUrls: string[]) => Promise<IpcResponse<AddPhotosResultDTO>>
    setPhotoWallPortrait: (dataUrl: string | null) => Promise<IpcResponse<string | null>>
    setPhotoWallRounded: (rounded: boolean) => Promise<IpcResponse<boolean>>
    deletePhotoWallPhoto: (imageId: number) => Promise<IpcResponse<number>>
    clearPhotoWall: () => Promise<IpcResponse<number>>
    exportPhotoWall: () => Promise<IpcResponse<PhotoWallExportResultDTO>>
    exportDiaryBackup: (data: ExportDiaryBackupDTO) => Promise<IpcResponse<BackupExportResultDTO>>
    importDiaryBackup: (data: ImportDiaryBackupDTO) => Promise<IpcResponse<BackupImportResultDTO>>
    getCloseBehavior: () => Promise<IpcResponse<CloseBehaviorDTO>>
    setCloseBehavior: (data: { action: CloseAction }) => Promise<IpcResponse<null>>
    resolveClose: (data: ResolveCloseDTO) => Promise<IpcResponse<null>>
    onCloseQuery: (callback: (action: CloseAction) => void) => () => void
  }
  interface Window {
    electron: { ipcRenderer: { send: (channel: 'vue-app-ready') => void } }
    api: IAppApi // mounts the custom API
  }
}
