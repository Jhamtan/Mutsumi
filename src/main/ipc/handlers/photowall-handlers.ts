/**
 * Photo wall IPC handlers: read state, change the minimum upload count, batch-add
 * photos, set the portrait image, load the photo list, delete a single photo,
 * clear, and export the wallpaper. The user id comes from the main-process session.
 */
import { BrowserWindow, dialog, ipcMain, type SaveDialogOptions } from 'electron'
import { z } from 'zod'
import {
  AddPhotosSchema,
  PhotoWallImageIdSchema,
  PhotoWallLimitsSchema,
  PhotoWallPhotoPageSchema,
  SetMinImagesSchema,
  SetRoundedSchema,
  SetPortraitSchema
} from '../schemas'
import { handleWithValidation } from '../validator'
import { captureSession } from '../security'
import { PHOTOWALL_BATCH_MAX_BYTES, PHOTOWALL_PORTRAIT_MAX_BYTES } from '@common/photowall'
import PhotoWallService from '../../services/PhotoWallService'
import PhotoWallLimitsService from '../../services/PhotoWallLimitsService'
import { AppError } from '../../errors'

const walls = new PhotoWallService()
const limits = new PhotoWallLimitsService()

/**
 * Registers the photo wall IPC handlers.
 */
export function registerPhotoWallHandlers(): void {
  ipcMain.handle(
    'photowall:get',
    handleWithValidation(
      z.undefined(),
      async (_data, event) => {
        const { userId, assertActive } = captureSession(event)
        return walls.getState(userId, assertActive, limits.get(userId, assertActive))
      },
      { requireAuth: true }
    )
  )

  ipcMain.handle(
    'photowall:photos',
    handleWithValidation(
      z.undefined(),
      async (_data, event) => {
        const { userId, assertActive } = captureSession(event)
        return walls.listPhotos(userId, assertActive)
      },
      { requireAuth: true }
    )
  )

  ipcMain.handle(
    'photowall:photo-page',
    handleWithValidation(
      PhotoWallPhotoPageSchema,
      async (data, event) => {
        const { userId, assertActive } = captureSession(event)
        return walls.listPhotoPage(userId, data, assertActive, limits.get(userId, assertActive))
      },
      { requireAuth: true }
    )
  )

  ipcMain.handle(
    'photowall:get-limits',
    handleWithValidation(
      z.undefined(),
      async (_data, event) => {
        const { userId, assertActive } = captureSession(event)
        const configured = limits.get(userId, assertActive)
        const usedBytes = await walls.getUsage(userId, assertActive)
        assertActive()
        return { ...configured, usedBytes }
      },
      { requireAuth: true }
    )
  )

  ipcMain.handle(
    'photowall:set-limits',
    handleWithValidation(
      PhotoWallLimitsSchema,
      async (data, event) => {
        const { userId, assertActive } = captureSession(event)
        const usedBytes = await walls.getUsage(userId, assertActive)
        assertActive()
        if (data.totalMaxBytes < usedBytes)
          throw new AppError('Capacity is below current usage.', 'PHOTOWALL_CAPACITY_EXCEEDED')
        return { ...limits.set(userId, data, assertActive), usedBytes }
      },
      { requireAuth: true }
    )
  )

  ipcMain.handle(
    'photowall:set-min-images',
    handleWithValidation(
      SetMinImagesSchema,
      async (data, event) => {
        const { userId, assertActive } = captureSession(event)
        return walls.setMinImages(userId, data.minImages, assertActive)
      },
      { requireAuth: true }
    )
  )

  ipcMain.handle(
    'photowall:add-photos',
    handleWithValidation(
      AddPhotosSchema,
      async (data, event) => {
        const { userId, assertActive } = captureSession(event)
        return walls.addPhotos(
          userId,
          data.dataUrls,
          assertActive,
          limits.get(userId, assertActive)
        )
      },
      {
        requireAuth: true,
        maxPayloadBytes: Math.ceil(PHOTOWALL_BATCH_MAX_BYTES / 3) * 4 + 64 * 1024,
        rateLimit: { bucket: 'photowall:upload', maxRequests: 8, windowMs: 60_000 }
      }
    )
  )

  ipcMain.handle(
    'photowall:set-portrait',
    handleWithValidation(
      SetPortraitSchema,
      async (data, event) => {
        const { userId, assertActive } = captureSession(event)
        return walls.setPortrait(
          userId,
          data.dataUrl,
          assertActive,
          limits.get(userId, assertActive)
        )
      },
      {
        requireAuth: true,
        maxPayloadBytes: Math.ceil(PHOTOWALL_PORTRAIT_MAX_BYTES / 3) * 4 + 64 * 1024,
        rateLimit: { bucket: 'photowall:upload', maxRequests: 8, windowMs: 60_000 }
      }
    )
  )

  ipcMain.handle(
    'photowall:set-rounded',
    handleWithValidation(
      SetRoundedSchema,
      async (data, event) => {
        const { userId, assertActive } = captureSession(event)
        return walls.setRounded(userId, data.rounded, assertActive)
      },
      { requireAuth: true }
    )
  )

  ipcMain.handle(
    'photowall:delete-photo',
    handleWithValidation(
      PhotoWallImageIdSchema,
      async (data, event) => {
        const { userId, assertActive } = captureSession(event)
        return walls.deletePhoto(userId, data.imageId, assertActive)
      },
      { requireAuth: true }
    )
  )

  ipcMain.handle(
    'photowall:clear',
    handleWithValidation(
      z.undefined(),
      async (_data, event) => {
        const { userId, assertActive } = captureSession(event)
        return walls.clearPhotos(userId, assertActive)
      },
      { requireAuth: true }
    )
  )

  ipcMain.handle(
    'photowall:export',
    handleWithValidation(
      z.undefined(),
      async (_data, event) => {
        const { userId, assertActive } = captureSession(event)
        const window = BrowserWindow.fromWebContents(event.sender)
        const options: SaveDialogOptions = {
          title: '导出照片墙壁纸',
          defaultPath: 'photo-wall-wallpaper.zip',
          filters: [{ name: 'Wallpaper package', extensions: ['zip'] }],
          properties: ['createDirectory', 'showOverwriteConfirmation']
        }
        const selection = window
          ? await dialog.showSaveDialog(window, options)
          : await dialog.showSaveDialog(options)
        assertActive()
        if (selection.canceled || !selection.filePath) return { canceled: true }

        const result = await walls.exportWallpaper(
          userId,
          selection.filePath,
          assertActive,
          limits.get(userId, assertActive)
        )
        return { canceled: false, filePath: selection.filePath, photoCount: result.photoCount }
      },
      {
        requireAuth: true,
        rateLimit: { bucket: 'photowall:export', maxRequests: 4, windowMs: 60_000 }
      }
    )
  )
}
