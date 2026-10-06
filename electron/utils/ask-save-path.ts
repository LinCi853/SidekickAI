import type { Session } from 'electron'

interface SaveIntent {
  url: string
  expiresAt: number
  cancel: () => void
}

const intentsBySession = new WeakMap<Session, Set<SaveIntent>>()
const intentLifetime = 60000

/** Requests one save dialog for an exact URL in its initiating session. */
export function markAskSavePath(session: Session, url: string): () => void {
  const intents = intentsBySession.get(session) ?? new Set<SaveIntent>()
  intentsBySession.set(session, intents)
  const intent: SaveIntent = { url, expiresAt: Date.now() + intentLifetime, cancel: () => {} }
  let active = true
  const cancel = () => {
    if (!active) return
    active = false
    clearTimeout(timer)
    intents.delete(intent)
    if (!intents.size) intentsBySession.delete(session)
  }
  const timer = setTimeout(cancel, intentLifetime)
  timer.unref?.()
  intent.cancel = cancel
  intents.add(intent)
  return cancel
}

/** Consumes only a matching live request; unrelated downloads retain their normal path. */
export function consumeAskSavePath(session: Session, requestedUrl: string): boolean {
  const intents = intentsBySession.get(session)
  if (!intents) return false
  for (const intent of intents) {
    if (Date.now() >= intent.expiresAt) { intent.cancel(); continue }
    if (intent.url !== requestedUrl) continue
    intent.cancel()
    return true
  }
  return false
}
