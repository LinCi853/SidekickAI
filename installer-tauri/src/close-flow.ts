// installer-tauri/src/close-flow.ts
// Close/cancel decisions for the installer wizard.
//
// The backend arbitrates cancellation with one compare-and-swap and returns an
// explicit result: `cancel()` is `true` only when it won before the engine
// started, and `close_window` is `false` while any operation is still busy.
// These helpers turn those results into an explicit UI outcome so the wizard
// never shows a false "closed" or "cancelled" state while work is still running.

/** Shown when the engine already started, so cancellation is no longer real. */
export const CANCEL_TOO_LATE = '正在完成当前操作，完成后即可关闭向导。'

/** Shown when a close request was refused because an operation is still busy. */
export const CLOSE_BLOCKED = '正在完成当前操作，请稍候。'

export type CloseOutcome =
  /** The window is gone / may be closed now. */
  | { kind: 'close' }
  /** Cancellation was accepted: wait for the terminal event, then close. */
  | { kind: 'wait-for-terminal' }
  /** Stay where we are (busy state kept) and show this banner. */
  | { kind: 'stay'; banner: string }

/**
 * Outcome for a completed cancel request. An accepted cancellation must not
 * close the protected window immediately: the backend still has to unwind and
 * emit the terminal event, so the caller waits for it.
 */
export function afterCancelRequest(accepted: boolean): CloseOutcome {
  return accepted
    ? { kind: 'wait-for-terminal' }
    : { kind: 'stay', banner: CANCEL_TOO_LATE }
}

/** Outcome for a completed `closeWindow()` call. */
export function afterCloseWindow(closed: boolean): CloseOutcome {
  return closed ? { kind: 'close' } : { kind: 'stay', banner: CLOSE_BLOCKED }
}
