# Mutsumi

A private, local-first desktop journal for Windows / macOS / Linux. Diaries are
stored in password-protected notebooks and encrypted with AES-256-GCM, so your
notes never leave your device in plaintext. It also keeps trip itineraries and a
photo wall that can be exported as a Wallpaper Engine web wallpaper.

## Features

- **Accounts** — local registration and sign-in. Passwords are hashed with bcrypt;
  authentication is confirmed by the main process session, never by `localStorage`.
- **Secure "remember me"** — optionally remember email + password using the OS
  keychain (`safeStorage`). The plaintext password is never returned to the
  renderer and never downgrades when encryption is unavailable.
- **Encrypted notebooks & diaries** — each notebook wraps its own 256-bit data key
  under your password (scrypt + AES-256-GCM). Diary Markdown and images are
  encrypted with per-entry authentication binding (AAD).
- **Markdown editor** — split edit/preview, source mode, image insertion, a
  formatting action (markdownlint profile) and a built-in syntax reference.
  Preview HTML is sanitized with DOMPurify.
- **Itineraries (trips)** — dedicated list, diagram and editing pages. The
  horizontal diagram shows start/intermediate/end places, transport arrows,
  arrival/departure clocks and stay durations. Its title is the itinerary name;
  its subtitle uses the departure's local calendar date. Click the diagram to
  edit the name, places and travel legs in dialogs; add intermediate stops from
  the top-right control. Saving opens the display page; the editor's back
  control confirms discarding unsaved work. The Trips sidebar returns to the
  last valid trip subpage in the current sign-in session, including abandoned
  trips, which can still be restored or permanently deleted.
- **Photo wall** — upload photos plus an optional foreground character cutout,
  preview a scrolling wall, and export a Wallpaper Engine web wallpaper archive.
- **Diary backup** — export/import an encrypted, portable notebook archive
  (versioned format with path-traversal and zip-bomb protections).
- **System tray & close policy** — hide to tray or quit; remember the choice.
- **Localization** — Chinese and English UI.

## Tech stack

- Electron + [electron-vite](https://electron-vite.org/)
- Vue 3 (Composition API) + TypeScript
- Pinia + Vue Router (hash history) + Element Plus + UnoCSS
- Sequelize + sequelize-typescript on SQLite (`sqlite3`)
- `bcryptjs`, `sharp`, `marked` + `DOMPurify`, `markdownlint`, `zod`
- `electron-store`, `electron-log`, `yazl`/`yauzl`
- Vitest + `@vue/test-utils` + jsdom for tests

## Requirements

- Node.js 22+ and npm (the project was verified with Node 22 and npm 10).
- `npm install` triggers `electron-builder install-app-deps`, which rebuilds the
  native modules (`sqlite3`, `sharp`) against the Electron runtime.

## Getting started

```bash
# install dependencies (rebuilds native modules for Electron)
npm install

# start in development (HMR)
npm run dev

# type-check the whole codebase (main, preload, renderer, tests)
npm run typecheck

# lint
npm run lint

# run the unit tests
npm run test:unit

# run the isolated security test suite (single worker)
npm run test:security

# run the CommonJS regression tests
npm run test:regression

# run everything: unit + regression
npm test

# run with coverage (90% thresholds on the covered modules)
npm run test:coverage

# production build (bundles + type-check)
npm run build
```

## Packaging

```bash
# unpacked build (fast verification, no installer)
npm run build:unpack

# per-platform installers
npm run build:win
npm run build:mac
npm run build:linux
```

Packaging is configured in `electron-builder.yml` (`productName: mutsumi`). The
`appId` is still the scaffold placeholder (`com.electron.app`) because no real
identifier was provided, and no auto-update server is configured.

## Directory layout

```
src/
  main/            Electron main process
    ipc/           validated IPC bridge (security, validator, schemas, handlers)
    database/      Sequelize models, repositories, transactions
    services/      business logic (diary, notebook, itinerary, photo wall, backup)
    crypto/        notebook AES-256-GCM cryptography
    window/        navigation policy and close/tray control
  preload/         fixed context-bridge API (window.api / window.electron)
  renderer/src/    Vue renderer
    views/         pages and layouts
    components/    EmailInput, MarkdownEditor, CloseDialog
    store/         Pinia stores (user, i18n, notebook)
    composables/   useEmailSuggest, useSessionOperation
    utils/         markdown, draft storage, date, photo wall helpers
  common/          DTOs, limits and validation constants shared across processes
tests/
  unit/            Vitest unit + security tests
  *.test.cjs       CommonJS regression tests
```

## Storage, encryption and data boundaries

- **Database** — a local SQLite file at `userData/mutsumi.db` (the project
  directory in development). Only tables for the migrated models are created;
  schema is synced with `sync()` (create-only, never `alter`/`force`).
- **Window & close preferences** — `electron-store` JSON files
  (`window-state.json`, `close-behavior.json`).
- **Remembered account** — stored in `userData/remembered-account.v1.json`,
  encrypted with the OS `safeStorage`; only the email is shown to the renderer.
- **Notebook/diary encryption** — each notebook wraps a random 256-bit data key
  with scrypt + AES-256-GCM; diary content and images are encrypted with
  per-entry AAD. Keys live only in main-process memory while a notebook is
  unlocked and are scrubbed on lock/logout/navigation.
- **This migration does not move existing user databases, system-encrypted
  credentials or real diary data.** Path compatibility after the rename must be
  confirmed separately.

## Capacity limits

- **Diary** — 2 MiB of Markdown, at most 40 images, 10 MiB per image, 100 MiB
  aggregate per diary.
- **Backup** — at most 2 000 entries, 64 MiB per entry, 1 GiB uncompressed total,
  a 200x compression-ratio guard.
- **Photo wall** — 200 photos, 5 MiB per ordinary photo (configurable 1–10 MiB),
  20 MiB per character cutout, 25 MiB per upload batch, 64 MiB total capacity
  (configurable 64–512 MiB). Previews are paged at 10 per page, 640 px / 128 KiB
  display copies.

## Backup & Wallpaper Engine

- **Diary backup** — choose **Export diary backup** in a notebook's diary list
  to export all its saved entries and images, not just the current page, into
  an encrypted `.zip` archive. Unsaved local drafts are not included. In **My notebooks**, choose **Import diary backup**,
  enter the notebook password used when exporting, and select the archive.
  Import creates a new, unlocked notebook in the current account without
  overwriting existing notebooks. The native file dialogs remain main-process
  controlled; cancellation and invalid archives do not change existing data.
- **Local diary drafts** — the editor restores per-account/per-notebook/per-entry
  drafts, autosaves text after editing pauses, and keeps the selected time and
  draft-image references. Pending edits are flushed when leaving or reloading.
  A successful entry save clears its draft and separate image records; failed
  or stale saves retain the draft. **Discard draft** requires confirmation and
  does not delete a saved entry. Drafts use **unencrypted localStorage**, not the
  encrypted diary database or backup format; use a trusted device. Storage
  failures are reported without blocking a normal entry save.
- **Wallpaper Engine** — in the photo wall, choose **Export wallpaper**, extract
  the archive, then in the Wallpaper Engine editor click **Create Wallpaper** and
  drop the extracted `index.html` into it. A combo property `Scroll speed`
  (`key: speed`) can be added in **Change Project settings**.

## Commit convention

Commits follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)
with messages written in English: `feat` for new features, `fix` for fixes,
`chore`/`build`/`docs`/`test` for maintenance; `!` / `BREAKING CHANGE:` only for
breaking changes.

## Not yet verified

The following need to be verified outside the automated test suite:

- Real GUI interaction (a live Electron window, dialogs, tray).
- OS keychain encryption end-to-end (Windows DPAPI, macOS Keychain, Linux
  libsecret/kwallet).
- Packaged native modules and ASAR resources at runtime (a build was produced,
  but it has not been launched).
- Wallpaper Engine import of an exported archive.
- macOS / Linux builds (only the Windows unpacked build was produced here).
