import { contextBridge, ipcRenderer } from 'electron'
/** Expose only fixed business channels; Electron is the sole runtime dependency of the sandboxed preload. */
const api = {
  createUser: (data) => ipcRenderer.invoke('user:create', data),
  login: (email, password, options?) =>
    ipcRenderer.invoke('user:login', {
      email,
      password,
      ...(options?.rememberAccount !== undefined
        ? { rememberAccount: options.rememberAccount }
        : {})
    }),
  logout: () => ipcRenderer.invoke('user:logout'),
  getCurrentUser: () => ipcRenderer.invoke('user:session'),
  getRememberedAccount: () => ipcRenderer.invoke('user:remembered-account'),
  loginRemembered: (email, options?) =>
    ipcRenderer.invoke('user:login-remembered', {
      email,
      ...(options?.rememberAccount !== undefined
        ? { rememberAccount: options.rememberAccount }
        : {})
    }),
  forgetRememberedAccount: () => ipcRenderer.invoke('user:forget-remembered-account'),
  createNotebook: (data) => ipcRenderer.invoke('notebook:create', data),
  listNotebooks: () => ipcRenderer.invoke('notebook:list'),
  unlockNotebook: (data) => ipcRenderer.invoke('notebook:unlock', data),
  lockNotebook: (notebookId) => ipcRenderer.invoke('notebook:lock', { notebookId }),
  listDiaries: (notebookId) => ipcRenderer.invoke('diary:list', { notebookId }),
  listDiaryPage: (notebookId, options?) =>
    ipcRenderer.invoke('diary:list-page', {
      notebookId,
      ...(options?.page !== undefined ? { page: options.page } : {}),
      ...(options?.pageSize !== undefined ? { pageSize: options.pageSize } : {})
    }),
  getDiary: (notebookId, diaryId) => ipcRenderer.invoke('diary:get', { notebookId, diaryId }),
  createDiary: (data) => ipcRenderer.invoke('diary:create', data),
  updateDiary: (data) => ipcRenderer.invoke('diary:update', data),
  deleteDiary: (notebookId, diaryId) => ipcRenderer.invoke('diary:delete', { notebookId, diaryId }),
  listItineraries: () => ipcRenderer.invoke('itinerary:list'),
  listAbandonedItineraries: () => ipcRenderer.invoke('itinerary:abandoned'),
  getItinerary: (itineraryId) => ipcRenderer.invoke('itinerary:get', { itineraryId }),
  createItinerary: (data) => ipcRenderer.invoke('itinerary:create', data),
  updateItinerary: (data) => ipcRenderer.invoke('itinerary:update', data),
  deleteItinerary: (itineraryId) => ipcRenderer.invoke('itinerary:delete', { itineraryId }),
  restoreItinerary: (itineraryId) => ipcRenderer.invoke('itinerary:restore', { itineraryId }),
  purgeItinerary: (itineraryId) => ipcRenderer.invoke('itinerary:purge', { itineraryId }),
  getPhotoWall: () => ipcRenderer.invoke('photowall:get'),
  listPhotoWallPhotos: () => ipcRenderer.invoke('photowall:photos'),
  listPhotoWallPhotoPage: (options?) =>
    ipcRenderer.invoke('photowall:photo-page', {
      ...(options?.afterId !== undefined ? { afterId: options.afterId } : {}),
      ...(options?.pageSize !== undefined ? { pageSize: options.pageSize } : {})
    }),
  getPhotoWallLimits: () => ipcRenderer.invoke('photowall:get-limits'),
  setPhotoWallLimits: (limits) => ipcRenderer.invoke('photowall:set-limits', limits),
  setPhotoWallMinImages: (minImages) =>
    ipcRenderer.invoke('photowall:set-min-images', { minImages }),
  addPhotoWallPhotos: (dataUrls) => ipcRenderer.invoke('photowall:add-photos', { dataUrls }),
  setPhotoWallPortrait: (dataUrl) => ipcRenderer.invoke('photowall:set-portrait', { dataUrl }),
  setPhotoWallRounded: (rounded) => ipcRenderer.invoke('photowall:set-rounded', { rounded }),
  deletePhotoWallPhoto: (imageId) => ipcRenderer.invoke('photowall:delete-photo', { imageId }),
  clearPhotoWall: () => ipcRenderer.invoke('photowall:clear'),
  exportPhotoWall: () => ipcRenderer.invoke('photowall:export'),
  exportDiaryBackup: (data) => ipcRenderer.invoke('diary:backup-export', data),
  importDiaryBackup: (data) => ipcRenderer.invoke('diary:backup-import', data),
  getCloseBehavior: () => ipcRenderer.invoke('window:get-close-behavior'),
  setCloseBehavior: (data) => ipcRenderer.invoke('window:set-close-behavior', data),
  resolveClose: (data) => ipcRenderer.invoke('window:resolve-close', data),
  // Subscribe to the main-process "window about to close" query and return an unsubscribe function.
  onCloseQuery: (callback) => {
    const listener = (_event, action): void => callback(action)
    ipcRenderer.on('app:close-query', listener)
    return () => ipcRenderer.removeListener('app:close-query', listener)
  },
  getAppInfo: () => ipcRenderer.invoke('update:get-info'),
  getUpdateStatus: () => ipcRenderer.invoke('update:get-status'),
  getUpdateSettings: () => ipcRenderer.invoke('update:get-settings'),
  setAutoCheck: (autoCheck) => ipcRenderer.invoke('update:set-auto-check', { autoCheck }),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  // Subscribe to main-process update status broadcasts.
  onUpdateStatus: (callback) => {
    const listener = (_event, status): void => callback(status)
    ipcRenderer.on('update:status', listener)
    return () => ipcRenderer.removeListener('update:status', listener)
  }
}

// Keep the existing startup call working without exposing arbitrary send/invoke channels.
contextBridge.exposeInMainWorld('electron', {
  ipcRenderer: {
    send: (channel: 'vue-app-ready'): void => {
      if (channel === 'vue-app-ready') ipcRenderer.send('vue-app-ready')
    }
  }
})
contextBridge.exposeInMainWorld('api', api)
