/**
 * Shared main-process type definitions.
 */

/**
 * Persisted main-window geometry, restored on next launch. `x`/`y` are optional
 * because the window position is only recorded after the first close.
 */
export interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
}
