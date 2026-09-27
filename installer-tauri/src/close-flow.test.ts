import { describe, expect, it } from 'vitest'
import {
  afterCancelRequest,
  afterCloseWindow,
  CANCEL_TOO_LATE,
  CLOSE_BLOCKED
} from './close-flow'

describe('installer close flow', () => {
  it('waits for the terminal event when cancellation was accepted', () => {
    expect(afterCancelRequest(true)).toEqual({ kind: 'wait-for-terminal' })
  })

  it('keeps the busy state and explains when cancellation lost the engine race', () => {
    expect(afterCancelRequest(false)).toEqual({ kind: 'stay', banner: CANCEL_TOO_LATE })
  })

  it('closes only when the backend confirms the window closed', () => {
    expect(afterCloseWindow(true)).toEqual({ kind: 'close' })
  })

  it('stays open and explains when a close was refused while busy', () => {
    expect(afterCloseWindow(false)).toEqual({ kind: 'stay', banner: CLOSE_BLOCKED })
  })
})
