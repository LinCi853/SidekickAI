let active = 0

/** Suppress interactive save decisions while another launch owns the handoff. */
export function beginApplicationHandoff(): () => void {
  active++
  let released = false
  return () => { if (!released) { released = true; active-- } }
}

export function isApplicationHandoff(): boolean { return active > 0 }
