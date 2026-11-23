/** Allow only registered renderer pages; hash routing does not change the trust boundary. */
export function isAllowedRendererNavigation(target: string, rendererUrl: string): boolean {
  try {
    const destination = new URL(target)
    const renderer = new URL(rendererUrl)
    if (destination.username || destination.password || renderer.username || renderer.password) {
      return false
    }
    destination.hash = ''
    renderer.hash = ''
    return destination.href === renderer.href
  } catch {
    return false
  }
}

/** The external browser accepts only valid HTTP(S) URLs without embedded credentials. */
export function getSafeExternalUrl(target: string): string | null {
  try {
    const destination = new URL(target)
    if (
      !['http:', 'https:'].includes(destination.protocol) ||
      !destination.hostname ||
      destination.username ||
      destination.password
    ) {
      return null
    }
    return destination.href
  } catch {
    return null
  }
}
