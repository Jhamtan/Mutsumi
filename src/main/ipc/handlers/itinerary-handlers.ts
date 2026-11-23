/**
 * Itinerary IPC handlers: create, list, detail, update, soft delete (abandon),
 * abandoned list, restore and permanent delete. The user id always comes from
 * the main-process session, never from the renderer payload.
 */
import { ipcMain } from 'electron'
import { z } from 'zod'
import { CreateItinerarySchema, ItineraryIdSchema, UpdateItinerarySchema } from '../schemas'
import { handleWithValidation } from '../validator'
import { captureSession } from '../security'
import ItineraryService from '../../services/ItineraryService'

const itineraries = new ItineraryService()

/**
 * Registers the itinerary IPC handlers.
 */
export function registerItineraryHandlers(): void {
  ipcMain.handle(
    'itinerary:list',
    handleWithValidation(
      z.undefined(),
      async (_data, event) => {
        const { userId, assertActive } = captureSession(event)
        return itineraries.list(userId, assertActive)
      },
      { requireAuth: true }
    )
  )

  ipcMain.handle(
    'itinerary:abandoned',
    handleWithValidation(
      z.undefined(),
      async (_data, event) => {
        const { userId, assertActive } = captureSession(event)
        return itineraries.listAbandoned(userId, assertActive)
      },
      { requireAuth: true }
    )
  )

  ipcMain.handle(
    'itinerary:get',
    handleWithValidation(
      ItineraryIdSchema,
      async (data, event) => {
        const { userId, assertActive } = captureSession(event)
        return itineraries.get(userId, data.itineraryId, assertActive)
      },
      { requireAuth: true }
    )
  )

  ipcMain.handle(
    'itinerary:create',
    handleWithValidation(
      CreateItinerarySchema,
      async (data, event) => {
        const { userId, assertActive } = captureSession(event)
        return itineraries.create(userId, data, assertActive)
      },
      { requireAuth: true }
    )
  )

  ipcMain.handle(
    'itinerary:update',
    handleWithValidation(
      UpdateItinerarySchema,
      async (data, event) => {
        const { userId, assertActive } = captureSession(event)
        return itineraries.update(userId, data, assertActive)
      },
      { requireAuth: true }
    )
  )

  ipcMain.handle(
    'itinerary:delete',
    handleWithValidation(
      ItineraryIdSchema,
      async (data, event) => {
        const { userId, assertActive } = captureSession(event)
        return itineraries.softDelete(userId, data.itineraryId, assertActive)
      },
      { requireAuth: true }
    )
  )

  ipcMain.handle(
    'itinerary:restore',
    handleWithValidation(
      ItineraryIdSchema,
      async (data, event) => {
        const { userId, assertActive } = captureSession(event)
        return itineraries.restore(userId, data.itineraryId, assertActive)
      },
      { requireAuth: true }
    )
  )

  ipcMain.handle(
    'itinerary:purge',
    handleWithValidation(
      ItineraryIdSchema,
      async (data, event) => {
        const { userId, assertActive } = captureSession(event)
        return itineraries.purge(userId, data.itineraryId, assertActive)
      },
      { requireAuth: true }
    )
  )
}
