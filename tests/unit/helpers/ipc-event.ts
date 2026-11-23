import { EventEmitter } from 'node:events'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { afterEach, vi } from 'vitest'
import { trustIpcSender } from '../../../src/main/ipc/security'

/**
 * Test helper that fabricates an Electron IpcMainInvokeEvent with a mockable
 * WebContents sender and optionally registers it as a trusted window.
 */
const senders: EventEmitter[] = []

afterEach(() => {
  // Emit "destroyed" so the security layer clears session/notebook state attached to each sender.
  for (const sender of senders) sender.emit('destroyed')
  senders.length = 0
})

export function createIpcEvent(
  url = 'file:///app/index.html#/login',
  trusted = true,
  expectedUrl = 'file:///app/index.html'
) {
  const sender = Object.assign(new EventEmitter(), {
    // The main-frame URL is the origin asserted by trust checks; senderFrame mirrors it.
    mainFrame: { url },
    isDestroyed: vi.fn(() => false)
  })
  const event = {
    sender: sender as unknown as WebContents,
    senderFrame: sender.mainFrame
  } as IpcMainInvokeEvent
  senders.push(sender)
  // Register the expected renderer origin so assertTrustedSender accepts this window.
  if (trusted) trustIpcSender(event.sender, expectedUrl)
  return { event, sender }
}
