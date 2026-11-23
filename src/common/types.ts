/**
 * Shared types and DTOs for the IPC boundary.
 *
 * Values here cross the renderer/preload/main process boundary, so they must be
 * plain JSON-serializable data: dates are strings and no methods are allowed.
 */
export type {
  NotebookSummaryDTO,
  CreateNotebookDTO,
  UnlockNotebookDTO,
  DiarySummaryDTO,
  DiaryPageOptionsDTO,
  ListDiaryPageDTO,
  DiaryPageDTO,
  DiaryDTO,
  DiaryImageDTO,
  DiaryImageInputDTO,
  CreateDiaryDTO,
  UpdateDiaryDTO,
  ExportDiaryBackupDTO,
  ImportDiaryBackupDTO,
  BackupExportResultDTO,
  BackupImportResultDTO
} from './diary'

export type {
  TransportRole,
  TransportMode,
  ItineraryPlaceDTO,
  ItineraryLegDTO,
  ItineraryDTO,
  ItinerarySummaryDTO,
  ItineraryPlaceInputDTO,
  ItineraryLegInputDTO,
  CreateItineraryDTO,
  UpdateItineraryDTO
} from './itinerary'
export { TRANSPORT_MODES, transportModeLabel } from './itinerary'

export type {
  PhotoWallImageType,
  PhotoWallStateDTO,
  PhotoWallPhotoDTO,
  AddPhotosDTO,
  SetMinImagesDTO,
  SetPortraitDTO,
  SetRoundedDTO,
  AddPhotosResultDTO,
  PhotoWallExportResultDTO,
  PhotoWallLimitsDTO,
  PhotoWallUsageDTO,
  PhotoWallPhotoPageOptionsDTO,
  PhotoWallPhotoPageDTO
} from './photowall'
export { PHOTOWALL_MIN_IMAGES_DEFAULT } from './photowall'

// 1. Define the generic response envelope
/**
 * Unified envelope for every IPC response.
 *
 * `success` is always set; on success `data` carries the payload, and on
 * failure `message`/`code`/`errors` describe the error (`errors` holds Zod
 * validation details).
 */
export interface IpcResponse<T> {
  success: boolean
  data?: T
  message?: string
  errors?: unknown // Zod validation error details
  code?: string // error code
}

// 2. Define the plain-data interfaces (DTOs) the renderer consumes.
// Only properties are declared here; never add methods.
export interface UserDTO {
  id: number
  name: string
  email: string
  // The password must never appear here.
  createdAt: string // Date becomes a string after JSON serialization
  updatedAt: string
}

/** Login preferences are not credentials; remembered info is used only by the main process. */
export interface LoginOptionsDTO {
  rememberAccount?: boolean
}

/** The login page receives only the account and save status, never a decrypted password. */
export interface RememberedAccountInfoDTO {
  email: string
  hasSavedPassword: boolean
  encryptionAvailable: boolean
  recordStatus: 'none' | 'saved' | 'damaged' | 'unavailable'
}

export interface LoginPreferenceResultDTO {
  saved: boolean
  error?: 'unavailable' | 'storage-failed'
}

export interface LoginResultDTO extends UserDTO {
  rememberedAccount?: LoginPreferenceResultDTO
}

// 3. Define the create-user input shape (optional, kept consistent across processes)
export interface CreateUserDTO {
  name: string
  email: string
  password: string
}

// 4. Close-app behavior: minimize to the system tray, or quit outright
export type CloseAction = 'tray' | 'quit'

/** Persisted close behavior (read/saved by the settings page; the close dialog reads it as the default). */
export interface CloseBehaviorDTO {
  action: CloseAction
  remember: boolean
}

/** Selection submitted after the close dialog is confirmed. */
export interface ResolveCloseDTO {
  action: CloseAction
  remember: boolean
}
