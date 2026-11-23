/**
 * Database bootstrap: configures the shared Sequelize instance and synchronizes
 * the schema on startup.
 */
import { Sequelize } from 'sequelize-typescript'
import './transaction'
import { PathHelper } from '../libs/path'
import logger from '../logger'
import { User } from './models/user.model'
import { Notebook } from './models/notebook.model'
import { Diary } from './models/diary.model'
import { DiaryImage } from './models/diary-image.model'
import { Itinerary } from './models/itinerary.model'
import { ItineraryPlace } from './models/itinerary-place.model'
import { ItineraryLeg } from './models/itinerary-leg.model'
import { databaseErrorDetails } from './errors'

/** Shared SQLite Sequelize instance used by every repository. */
export const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: `${PathHelper.getHomeDir()}/mutsumi.db`,
  dialectOptions: {
    charset: 'utf8mb4',
    collate: 'utf8mb4_unicode_ci'
  },
  // Register models. Photo-wall models are added as they land.
  models: [User, Notebook, Diary, DiaryImage, Itinerary, ItineraryPlace, ItineraryLeg],
  // SQL may contain sensitive data; diagnostics log only allowlisted error types and codes
  logging: false
})

/**
 * Verifies connectivity and synchronizes the schema.
 *
 * Creates only missing tables and never alters existing ones. Under SQLite,
 * `sync({ alter: true })` rebuilds the whole table for every non-primary-key
 * column (build a backup -> copy -> DROP the original -> rename). When a table
 * such as photo_walls holds foreign-key rows referencing users
 * (ON DELETE NO ACTION), the DROP triggers a SQLITE_CONSTRAINT foreign-key
 * error and startup fails. So we always sync without `alter`, guaranteeing the
 * startup path never destroys user data.
 */
export async function initDatabase(): Promise<void> {
  try {
    await sequelize.authenticate()
    await sequelize.sync()
    logger.info('✅ Database connected and synced.')
  } catch (error) {
    logger.error('❌ Database connection failed:', databaseErrorDetails(error))
    // The raw cause may contain SQL/params; diagnostics are logged in safe fields, so never propagate it
    // eslint-disable-next-line preserve-caught-error
    throw new Error('Database initialization failed')
  }
}
